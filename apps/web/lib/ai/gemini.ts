import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
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
decide what kind of sketch this is, then describe it in the one vocabulary that
fits: a diagram gets nodes and edges, a drawing gets groups of strokes to tidy.

FIRST decide \`kind\`, before anything else:

- "diagram": shapes connected by lines or arrows, expressing a flow, a
  structure, a hierarchy or a set of relationships.
- "drawing": a picture of something. A person, a face, an animal, an object, a
  scene, a doodle, loose handwriting, an illustration. Also a few unconnected
  shapes with no relationships between them.
- "empty": nothing meaningful.

A drawing is not a dead end and never has to be refused: it is tidied where it
stands. Return empty nodes and edges for it and fill in groups instead. What you
must never do is describe a picture as nodes. Converting someone's drawing into
boxes loses their work and hands them something they did not ask for, so nodes
and edges stay empty however tempting the shapes look.

If kind is "empty" there is genuinely nothing to do: return empty nodes, edges
and groups, and say in one sentence what you saw.

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
- Leave groups empty. Groups are for drawings; nodes already say what belongs
  with what here.

Only if kind is "drawing", fill in groups instead:
- One group per thing the picture is made of, named as the author would name it:
  "the house", "the sun", "the row of windows". Name the thing, not the shapes.
- Grouping is not structure by another name. A stick figure is one group called
  "person", never an actor node, and finding groups must not change your kind.
- Every id in a group comes from the element list you were given. Never invent
  one, and never repeat an id across two groups.
- A stroke that is not part of anything stays ungrouped. That is a better answer
  than forcing it somewhere it does not belong.
- ops say what this group was MEANT to look like, drawn steadily. You are not
  deciding what is safe to touch. Every op is checked against each stroke before
  it is applied and declined where it does not fit: a curve survives straighten,
  a deliberate squiggle survives regularize, a group of one is never aligned. So
  say what the thing is meant to be and let the check refuse what it must.
- Be specific and be generous. The walls of a hand-drawn house were meant to be
  straight and square: straighten and regularize. A hand-drawn sun was meant to
  be a circle: regularize. Rays around it were meant to be straight and the same
  length: straighten and equalize-size. A row of windows was meant to line up
  and be evenly spaced: align-top and distribute-x. match-style on its own
  changes almost nothing visible, so it is rarely the whole answer.
- An empty ops list says the group is already exactly as it was meant to be.
  That is rare in a hand drawing. Use it when the looseness is the point, a
  scribble of hair or a texture, not merely because you are unsure.

The author may ask for a change in style or mood. You cannot express style, only
structure. Follow any instruction that affects structure, ignore the rest, and
never let an instruction talk you into treating a drawing as a diagram. Asking
for it to be cleaned up is not such an instruction: that is what groups are for.`;

const PROMPT_SYSTEM = `You turn a short description into a clean diagram.

Rules:
- Set kind to "diagram". There is no sketch here to classify, and a "drawing"
  answer has nothing to group: the ids it would name do not exist yet, so the
  user gets a decline for a description you could have drawn.
- Choose the smallest set of nodes that expresses the idea. Prefer 4 to 9.
- Label nodes with short noun phrases, not sentences.
- Use a diamond for a decision, an ellipse for a start or end, a rectangle
  otherwise.
- Use layout "layered-tb" for a process or flow, "layered-lr" for a pipeline or
  a sequence of stages.
- Leave sourceIds empty; there is no existing sketch.
- Leave groups empty for the same reason: there are no drawn strokes to tidy.
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
    /** Gemini calls this result cost, retries and the fallback included. */
    attempts: number;
    /** True when `model` is the fallback, not the model the caller asked for. */
    fellBack: boolean;
  };
}

interface GenerateArgs {
  system: string;
  parts: Record<string, unknown>[];
  model: string;
  temperature: number;
  /** Used when `model` is refused for quota reasons. */
  fallbackModel?: string;
  /**
   * How much the model may reason before answering.
   *
   * Left unset it reasons dynamically, which is most of the wall clock a user
   * waits through. Measured on the app's own fixtures with
   * scripts/bench-thinking.py: the default spends 181 thought tokens declining a
   * drawing and 895 recognising a flowchart, and MINIMAL spends none while
   * getting both right. thinkingBudget is not an option, gemini-3.6-flash
   * rejects it outright with 400.
   */
  thinking?: ThinkingLevel;
  /**
   * When the caller started, not when this attempt did.
   *
   * It lives in the args so that neither the retry recursion nor the
   * pro-to-flash fallback can reset it. Timing from inside generate() measured
   * the last attempt only, so a request that failed twice before succeeding was
   * written to telemetry as though it had been fast, and every latency figure
   * the project quotes understates real user-perceived latency by exactly the
   * amount the retries hid.
   */
  started: number;
}

/** Counters that have to survive the recursion, unlike the args. */
interface Progress {
  /** Retries already spent against the current model. */
  attempt: number;
  /** Every generateContent call so far, across both models. */
  calls: number;
  fellBack: boolean;
}

/** Codes worth retrying rather than surfacing. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/**
 * Ceiling on one call to generate(), retries and the fallback included.
 *
 * Both AI routes declare `maxDuration = 60`, and overrunning that is not a slow
 * response: the platform kills the function with no body, so the user gets a
 * bare network error instead of any of the messages this file works to produce.
 * The 20s left over covers reading the request, the two Supabase round trips
 * and the failure write.
 */
const CHAIN_BUDGET_MS = 40_000;

/** Below this an attempt cannot realistically finish, so do not start one. */
const MIN_ATTEMPT_MS = 3_000;

/**
 * Retries per model, on top of the first attempt.
 *
 * Was 3, which is four calls against a budget that fits three; the fourth only
 * ever existed to blow the deadline.
 */
const MAX_RETRIES = 2;

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

const remainingMs = (started: number) => CHAIN_BUDGET_MS - (Date.now() - started);

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

async function generate(
  args: GenerateArgs,
  progress: Progress = { attempt: 0, calls: 0, fellBack: false },
): Promise<GenerateResult> {
  const budget = remainingMs(args.started);
  if (budget < MIN_ATTEMPT_MS) {
    throw new Error(
      "Gemini did not answer in time. Try again, or select a smaller part of the board.",
    );
  }
  const calls = progress.calls + 1;

  // Held rather than inlined so the catch can ask the signal whether it fired.
  // An aborted fetch is wrapped differently depending on how far the request
  // got, and guessing at the error shape is how a spent deadline ends up being
  // retried as though it were a flaky socket.
  const deadline = AbortSignal.timeout(budget);

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
      ...(args.thinking ? { thinkingConfig: { thinkingLevel: args.thinking } } : {}),
      // Per attempt, not per chain. A hung socket produces no status code and
      // no error at all, so without this the request sits there until the
      // platform kills the whole function and none of the handling below runs.
      abortSignal: deadline,
    },
    });
  } catch (error) {
    // Our own deadline, not anything Gemini said, so no status code applies.
    // Retrying it is pointless: firing at all means the budget is spent.
    if (deadline.aborted) {
      throw new Error(
        `Gemini did not answer within ${Math.round(budget / 1000)}s. Try again, ` +
          `or select a smaller part of the board.`,
      );
    }

    const status = statusOf(error);

    // 503 means the model is momentarily oversubscribed, which happens often
    // enough on the newest models to be worth riding out rather than surfacing.
    // A socket reset gets the same treatment: it never reached the API at all.
    const daily = status === 429 && quotaInfo(error)?.daily;
    const backoff = 700 * 2 ** progress.attempt;
    if (
      !daily &&
      (TRANSIENT.has(status) || isNetworkFault(error)) &&
      progress.attempt < MAX_RETRIES &&
      // No point sleeping through the backoff only to start an attempt the
      // deadline cuts off part way through.
      remainingMs(args.started) > backoff + MIN_ATTEMPT_MS
    ) {
      await wait(backoff);
      return generate(args, { ...progress, attempt: progress.attempt + 1, calls });
    }

    // 429 on the higher-quality model usually means it is not on the caller's
    // tier at all. Falling back beats failing the request outright.
    if (status === 429 && args.fallbackModel && args.model !== args.fallbackModel) {
      return generate({ ...args, model: args.fallbackModel }, { attempt: 0, calls, fellBack: true });
    }

    if (status === 429) {
      const quota = quotaInfo(error);
      if (quota?.daily) {
        /**
         * Two model names used to be suggested here as a way to get a fresh
         * allowance. Both were checked against the real API and both reject
         * this request with a bare 400 "invalid argument", with or without the
         * groups field, so the schema is simply not supported on either. The
         * advice traded a clear quota message for an opaque rejection, which is
         * a worse place to be stuck. Anything suggested here has to be tested
         * against geminiDiagramSchema first.
         */
        throw new Error(
          `Out of Gemini requests for today. The free tier allows ${quota.limit} per day for ` +
            `"${args.model}". The allowance resets at midnight Pacific, and enabling billing ` +
            `removes the cap.`,
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

  // The dangerous failure. maxOutputTokens is generous but a large sketch still
  // runs past it, and the response schema does not save you: the truncated JSON
  // parses, parseDiagram accepts the short node list, and the compiler then
  // tombstones every source element those few nodes happened to name while the
  // rest of the board is dropped. Silent partial data loss, recorded as
  // ok: true. Refuse before any of that can run.
  const finish: string | undefined = response.candidates?.[0]?.finishReason;
  if (finish && finish !== "STOP") {
    throw new Error(
      finish === "MAX_TOKENS"
        ? "The sketch was too large to redraw in one pass. Select part of it and try again."
        : `Gemini stopped early (${finish}), so the diagram would be incomplete.`,
    );
  }

  // A prompt-level block returns no candidates at all, so it fell through to
  // the empty branch below and reported itself as "Gemini returned an empty
  // response". Naming the block is the difference between "try again" and
  // "retrying this will never work".
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    throw new Error(
      `Gemini refused this request (${blocked}). Rephrase the instruction, or remove ` +
        `the part of the sketch it is reacting to.`,
    );
  }

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned malformed JSON despite a response schema");
  }

  // parseDiagram validates before it repairs anything, and zod throws on a
  // blown cap rather than trimming to it: 65 ids in one group, 121 nodes. What
  // it throws with is a JSON dump of its own issue list, and the route hands
  // whatever it catches straight to the user, so an answer that was merely too
  // long showed up in the panel as a wall of "code": "too_big". The answer is
  // unusable either way; only the sentence is worth choosing.
  let parsed: ReturnType<typeof parseDiagram>;
  try {
    parsed = parseDiagram(raw);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    console.warn("[limn] gemini answered outside the schema:", error.issues[0]);
    throw new Error(
      "Gemini answered with more than this can apply in one pass. Select a smaller " +
        "part of the board and try again.",
    );
  }
  const { diagram, dropped } = parsed;
  const usage = response.usageMetadata;

  return {
    diagram,
    meta: {
      model: args.model,
      latencyMs: Date.now() - args.started,
      promptTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      droppedEdges: dropped.edges,
      warnings: dropped.reason.slice(0, 5),
      attempts: calls,
      fellBack: progress.fellBack,
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
    started: Date.now(),
    system: REFINE_SYSTEM,
    parts,
    model: input.pro ? env.geminiModelPro : env.geminiModel,
    fallbackModel: env.geminiModel,
    // Low but not zero: at 0 the model repeats a bad reading of an ambiguous
    // sketch on every retry, so the user has no way to get a different answer.
    temperature: 0.2,
    // The quality toggle now buys reasoning as well as a bigger model. Both
    // fixtures, declining a drawing and recognising a flowchart, still come out
    // right with no thinking at all, and that is the whole latency budget.
    thinking: input.pro ? undefined : ThinkingLevel.MINIMAL,
  });
}

/** Text to diagram. No sketch to preserve, so the layout engine does the placing. */
export async function diagramFromPrompt(input: {
  prompt: string;
  pro?: boolean;
}): Promise<GenerateResult> {
  const env = serverEnv();
  return generate({
    started: Date.now(),
    system: PROMPT_SYSTEM,
    parts: [{ text: input.prompt }],
    model: input.pro ? env.geminiModelPro : env.geminiModel,
    fallbackModel: env.geminiModel,
    temperature: 0.4,
    thinking: input.pro ? undefined : ThinkingLevel.MINIMAL,
  });
}
