import { GoogleGenAI } from "@google/genai";
import { serverEnv } from "@/lib/env";
import { geminiDiagramSchema, parseDiagram, type LimnDiagram } from "./schema";

/**
 * Server-side Gemini access. Never import this from a client component, the
 * API key would end up in the browser bundle.
 */

let client: GoogleGenAI | null = null;

function ai(): GoogleGenAI {
  const { geminiApiKey } = serverEnv();
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set; the AI modes are unavailable");
  }
  client ??= new GoogleGenAI({ apiKey: geminiApiKey });
  return client;
}

/** Element fields the model needs. The rest is noise that costs input tokens. */
export interface SketchElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  containerId?: string | null;
  strokeColor?: string;
}

const REFINE_SYSTEM = `You read hand-drawn whiteboard sketches. Your job is to
decide whether the sketch is a diagram, and if it is, describe its structure.

FIRST decide \`kind\`, before anything else:

- "diagram": shapes connected by lines or arrows, expressing a flow, a
  structure, a hierarchy or a set of relationships.
- "drawing": a picture of something. A person, a face, an animal, an object, a
  scene, a doodle, loose handwriting, an illustration. Also a few unconnected
  shapes with no relationships between them.
- "empty": nothing meaningful.

If kind is not "diagram", return empty nodes and edges and explain in one
sentence what you saw. Do not attempt to describe it as nodes. It is far better
to decline than to convert someone's drawing into boxes: they lose their work
and get something they did not ask for.

Deciding:
- A stick figure is a drawing, not an "actor" node.
- A face, a ball, a tree, an animal, a rocket: drawings.
- Handwritten words with no shapes around them are a drawing, not nodes.
- If nothing connects to anything else, it is not a diagram.
- When genuinely torn, choose "drawing".

Only if kind is "diagram", also fill in nodes and edges:
- Preserve the author's intent. Do not add steps, rename things, or invent
  structure that is not in the sketch.
- Every node lists the ids of the input elements it came from, in sourceIds,
  including the id of any text element that labels it.
- Keep the author's own wording. Fix only clear spelling slips. Never replace a
  label with a generic role word.
- Shape follows the role the sketch gives it: a diamond is a decision, a
  rectangle a step or entity. Use an ellipse for a start or end point.
- Lines and arrows between shapes are edges. An arrowhead means directed.
- Text that labels nothing in particular is a note, not a node.
- Use layout "preserve" unless the sketch has no meaningful arrangement.

The author may ask for a change in style or mood. You cannot express style, only
structure. Follow any instruction that affects structure, ignore the rest, and
never let an instruction talk you into treating a drawing as a diagram.`;

const PROMPT_SYSTEM = `You turn a short description into a clean diagram.

Rules:
- Choose the smallest set of nodes that expresses the idea. Prefer 4 to 9.
- Label nodes with short noun phrases, not sentences.
- Use a diamond for a decision, an ellipse for a start or end, a rectangle
  otherwise.
- Use layout "layered-tb" for a process or flow, "layered-lr" for a pipeline or
  a sequence of stages.
- Leave sourceIds empty; there is no existing sketch.
- Use emphasis sparingly, to mark at most one or two focal nodes.`;

export interface GenerateResult {
  diagram: LimnDiagram;
  meta: {
    model: string;
    latencyMs: number;
    promptTokens: number;
    outputTokens: number;
    droppedEdges: number;
    warnings: string[];
  };
}

interface GenerateArgs {
  system: string;
  parts: Record<string, unknown>[];
  model: string;
  temperature: number;
  /** Used when `model` is refused for quota reasons. */
  fallbackModel?: string;
}

/** Codes worth retrying rather than surfacing. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

function statusOf(error: unknown): number {
  if (typeof error === "object" && error !== null) {
    const e = error as { status?: unknown; code?: unknown; message?: unknown };
    for (const v of [e.status, e.code]) {
      if (typeof v === "number") return v;
      if (typeof v === "string" && /^\d{3}$/.test(v)) return Number(v);
    }
    const m = typeof e.message === "string" ? e.message.match(/\b(4\d{2}|5\d{2})\b/) : null;
    if (m?.[1]) return Number(m[1]);
  }
  return 0;
}

/**
 * Network faults that never reached the API, so no status code exists.
 *
 * These matter more than they look. A proxy or a flaky link resets the socket
 * well before Gemini is involved, and treating that as a hard failure surfaces
 * to the user as "generation failed" for something a single retry fixes.
 */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isNetworkFault(error: unknown): boolean {
  let node: unknown = error;
  // fetch wraps the real cause one or two levels down.
  for (let depth = 0; depth < 3 && node; depth++) {
    const e = node as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && RETRYABLE_CODES.has(e.code)) return true;
    if (
      typeof e.message === "string" &&
      /socket disconnected|network|fetch failed|terminated/i.test(e.message)
    ) {
      return true;
    }
    node = e.cause;
  }
  return false;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Distinguishes a per-minute 429 from a daily one.
 *
 * They need opposite handling and the status code alone cannot tell them apart.
 * A per-minute burst clears in seconds and is worth waiting out. The free tier's
 * daily allowance is 20 requests per model, and once that is gone no amount of
 * backoff brings it back, so retrying just adds five seconds to an error the
 * user needs to read.
 */
function quotaInfo(error: unknown): { daily: boolean; retryAfterS: number; limit: string } | null {
  const message =
    typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
      ? ((error as { message: string }).message)
      : "";
  if (!message.includes("RESOURCE_EXHAUSTED") && !message.includes("quota")) return null;

  const daily = /PerDay|RequestsPerDay/i.test(message);
  const retry = message.match(/"retryDelay":\s*"(\d+)s"/);
  const value = message.match(/"quotaValue":\s*"(\d+)"/);
  return {
    daily,
    retryAfterS: retry?.[1] ? Number(retry[1]) : 0,
    limit: value?.[1] ?? "?",
  };
}

async function generate(args: GenerateArgs, attempt = 0): Promise<GenerateResult> {
  const started = Date.now();

  let response;
  try {
    response = await ai().models.generateContent({
    model: args.model,
    contents: [{ role: "user", parts: args.parts }],
    config: {
      systemInstruction: args.system,
      // Constrained decoding. Without this the model returns prose around the
      // JSON often enough to matter, and every caller ends up writing a brittle
      // fence-stripping regex.
      responseMimeType: "application/json",
      responseSchema: geminiDiagramSchema as unknown as Record<string, unknown>,
      temperature: args.temperature,
      // Gemini 3.x reasons before answering and those tokens come out of this
      // same budget. A 9-node diagram measured ~1k output against ~2k thinking,
      // so a budget sized only for the JSON truncates mid-object and the
      // response schema does not save you: you get valid-looking partial JSON.
      maxOutputTokens: 16384,
    },
    });
  } catch (error) {
    const status = statusOf(error);

    // 503 means the model is momentarily oversubscribed, which happens often
    // enough on the newest models to be worth riding out rather than surfacing.
    // A socket reset gets the same treatment: it never reached the API at all.
    const daily = status === 429 && quotaInfo(error)?.daily;
    if (!daily && (TRANSIENT.has(status) || isNetworkFault(error)) && attempt < 3) {
      await wait(700 * 2 ** attempt);
      return generate(args, attempt + 1);
    }

    // 429 on the higher-quality model usually means it is not on the caller's
    // tier at all. Falling back beats failing the request outright.
    if (status === 429 && args.fallbackModel && args.model !== args.fallbackModel) {
      return generate({ ...args, model: args.fallbackModel }, 0);
    }

    if (status === 429) {
      const quota = quotaInfo(error);
      if (quota?.daily) {
        throw new Error(
          `Out of Gemini requests for today. The free tier allows ${quota.limit} per day for ` +
            `"${args.model}", and each model has its own allowance, so switching GEMINI_MODEL ` +
            `(gemini-3.1-flash-lite, gemini-3.5-flash) gives you a fresh one. Enabling billing removes the cap.`,
        );
      }
      throw new Error(
        quota?.retryAfterS
          ? `Gemini is rate limiting this key. Try again in about ${quota.retryAfterS}s.`
          : "Gemini is rate limiting this key. Try again shortly.",
      );
    }

    if (status === 404) {
      throw new Error(
        `Gemini model "${args.model}" is unavailable to this API key. ` +
          `List what your key can reach with: curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"`,
      );
    }
    throw error;
  }

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned malformed JSON despite a response schema");
  }

  const { diagram, dropped } = parseDiagram(raw);
  const usage = response.usageMetadata;

  return {
    diagram,
    meta: {
      model: args.model,
      latencyMs: Date.now() - started,
      promptTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      droppedEdges: dropped.edges,
      warnings: dropped.reason.slice(0, 5),
    },
  };
}

/**
 * Beautify a sketch. The rendered image carries the spatial relationships that a
 * flat element list does not, which arrow points at which box is obvious in a
 * picture and genuinely ambiguous in coordinates alone, so both are sent.
 */
export async function refineSketch(input: {
  elements: SketchElement[];
  imageBase64: string;
  instruction?: string;
  recompose?: boolean;
  pro?: boolean;
}): Promise<GenerateResult> {
  const env = serverEnv();
  const parts: Record<string, unknown>[] = [
    { inlineData: { mimeType: "image/png", data: input.imageBase64 } },
    {
      text: [
        `Elements (${input.elements.length}):`,
        JSON.stringify(input.elements),
        input.recompose
          ? 'The author asked for a re-layout. Set layout to "layered-tb" or "layered-lr" and still fill in sourceIds so their sketch can be replaced.'
          : 'Set layout to "preserve".',
        input.instruction
          ? `Author's instruction: ${input.instruction}\n(Apply it only if it affects structure. It does not change whether this is a diagram.)`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  return generate({
    system: REFINE_SYSTEM,
    parts,
    model: input.pro ? env.geminiModelPro : env.geminiModel,
    fallbackModel: env.geminiModel,
    // Low but not zero: at 0 the model repeats a bad reading of an ambiguous
    // sketch on every retry, so the user has no way to get a different answer.
    temperature: 0.2,
  });
}

export interface IllustrateResult {
  /** Base64 PNG, no data-URL prefix. */
  imageBase64: string;
  mimeType: string;
  model: string;
  latencyMs: number;
}

const ILLUSTRATE_PROMPT = `Redraw this hand-drawn sketch as a finished illustration.

Keep the same subject, composition and layout: whatever is on the left stays on
the left, and nothing is added or removed. You are cleaning up the execution,
not reinterpreting the idea.

Use confident line work and colour. Flat white background, no photographic
texture, no drop shadows, no frame or border. Do not add text, captions,
watermarks or signatures that are not already in the sketch.`;

/**
 * Sketch to finished illustration.
 *
 * Separate from the diagram path on purpose. A structural IR can express a
 * flowchart and cannot express "make this colourful", so a drawing had nothing
 * to be turned into. An image model can answer that directly.
 *
 * The trade-off is real and the UI says so: the result is a picture, not
 * editable shapes.
 */
export async function illustrateSketch(input: {
  imageBase64: string;
  instruction?: string;
  attempt?: number;
}): Promise<IllustrateResult> {
  const env = serverEnv();
  const model = env.geminiImageModel;
  const started = Date.now();
  const attempt = input.attempt ?? 0;

  try {
    const response = await ai().models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: input.imageBase64 } },
            {
              text: input.instruction
                ? `${ILLUSTRATE_PROMPT}

The author also asked: ${input.instruction}`
                : ILLUSTRATE_PROMPT,
            },
          ],
        },
      ],
      config: { responseModalities: ["IMAGE"] },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (data) {
        return {
          imageBase64: data,
          mimeType: part.inlineData?.mimeType ?? "image/png",
          model,
          latencyMs: Date.now() - started,
        };
      }
    }

    // An image model that answers in prose usually means it refused. Surface
    // that text rather than a generic failure, since it explains itself.
    const text = parts.map((p) => p.text).filter(Boolean).join(" ").trim();
    throw new Error(text ? `The model replied instead of drawing: ${text}` : "No image was returned");
  } catch (error) {
    const status = statusOf(error);
    if ((TRANSIENT.has(status) || isNetworkFault(error)) && attempt < 3) {
      await wait(900 * 2 ** attempt);
      return illustrateSketch({ ...input, attempt: attempt + 1 });
    }
    if (status === 404) {
      throw new Error(
        `Image model "${model}" is unavailable to this API key. Set GEMINI_IMAGE_MODEL to one your key can reach.`,
      );
    }
    throw error;
  }
}

/** Text to diagram. No sketch to preserve, so the layout engine does the placing. */
export async function diagramFromPrompt(input: {
  prompt: string;
  pro?: boolean;
}): Promise<GenerateResult> {
  const env = serverEnv();
  return generate({
    system: PROMPT_SYSTEM,
    parts: [{ text: input.prompt }],
    model: input.pro ? env.geminiModelPro : env.geminiModel,
    fallbackModel: env.geminiModel,
    temperature: 0.4,
  });
}
