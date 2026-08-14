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

const REFINE_SYSTEM = `You read hand-drawn whiteboard sketches and describe what the author meant.

You are given a rendered image of a sketch and a list of its elements with ids
and positions. Return a structured diagram describing the same content.

Rules:
- Preserve the author's intent exactly. Do not add steps, rename things, or
  invent structure that is not in the sketch.
- Every node must list the ids of the input elements it came from, in sourceIds,
  including the id of any text element that labels it.
- Keep the author's own wording for labels, including abbreviations. Fix only
  clear spelling slips.
- Read a diamond as a decision, an ellipse as a start/end or an actor, and a
  rectangle as a step or entity. If a shape is ambiguous, choose by its role in
  the diagram rather than by how it was drawn.
- Lines and arrows between shapes are edges. An arrowhead means directed; a plain
  line between two shapes is usually directed along the reading order, but say
  directed: false if the sketch clearly shows a plain association.
- Text that labels nothing in particular is a note, not a node.
- Use layout "preserve" unless the sketch has no meaningful arrangement.`;

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
    if ((TRANSIENT.has(status) || isNetworkFault(error)) && attempt < 3) {
      await wait(700 * 2 ** attempt);
      return generate(args, attempt + 1);
    }

    // 429 on the higher-quality model usually means it is not on the caller's
    // tier at all. Falling back beats failing the request outright.
    if (status === 429 && args.fallbackModel && args.model !== args.fallbackModel) {
      return generate({ ...args, model: args.fallbackModel }, 0);
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
        input.instruction ? `Author's instruction: ${input.instruction}` : "",
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
