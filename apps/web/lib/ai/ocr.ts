import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { serverEnv } from "@/lib/env";

/**
 * Reading the handwriting off a photographed whiteboard.
 *
 * apps/vision traces ink into shapes and has no idea what any of it says, so a
 * board of labelled boxes comes back as boxes with nothing in them. This is the
 * step that puts the words back, and it runs beside the trace rather than inside
 * it: OpenCV is good at edges and hopeless at cursive.
 *
 * Server-side only, like lib/ai/gemini.ts. Importing this from a client
 * component would put GEMINI_API_KEY in the browser bundle.
 *
 * The client accessor and the failure classification below are copies of the
 * ones in lib/ai/gemini.ts, which keeps them module-private. If they are ever
 * exported, import them here rather than keeping two copies in step.
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

const OCR_SYSTEM = `You read the handwriting in a photograph of a whiteboard.

Return one item per readable piece of text, each with a box saying where on the
board it sits.

Rules:
- Transcribe what is written, exactly. Do not correct grammar, expand an
  abbreviation, tidy up phrasing, or translate. Fix only an obvious slip of the
  pen.
- One item per label, heading, or line. Words inside the same box or on the same
  line belong to one item. Text in different places on the board goes in separate
  items, however similar it reads.
- Boxes are fractions of the image: 0 is the left or top edge, 1 is the right or
  bottom edge. x and y are the top-left corner of the text. Never answer in
  pixels. The caller scales the traced board on its own, so pixel coordinates
  would put every word in the wrong place.
- Do not transcribe things that are not writing. Arrows, boxes, connectors,
  underlines and drawings are traced separately and are not text.
- Confidence is how sure you are of the reading, from 0 to 1. Give a word you are
  guessing at a low confidence rather than leaving it out.
- If the photo has no writing on it, or the writing is too small or too blurred
  to read, return an empty list and say so in one sentence. An invented word is
  worse than a missing one: it lands on the author's board as though they wrote
  it, and they have no way to tell that they did not.`;

/**
 * The same contract in the OpenAPI subset Gemini accepts as `responseSchema`.
 *
 * Flat x/y/width/height rather than a nested box object: the field descriptions
 * are where the model actually reads the "fractions, not pixels" instruction,
 * and a nested object buries them a level down where it ignores them more often.
 */
export const geminiOcrSchema = {
  type: "object",
  properties: {
    text: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The words as written, in the author's own spelling and capitalisation.",
          },
          x: {
            type: "number",
            description: "Left edge of the text, as a fraction of image width. 0 to 1.",
          },
          y: {
            type: "number",
            description: "Top edge of the text, as a fraction of image height. 0 to 1.",
          },
          width: {
            type: "number",
            description: "Width of the text, as a fraction of image width. 0 to 1.",
          },
          height: {
            type: "number",
            description: "Height of the text, as a fraction of image height. 0 to 1.",
          },
          confidence: {
            type: "number",
            description:
              "How sure you are of this reading, 0 to 1. Below 0.4 means you are guessing.",
          },
        },
        required: ["text", "x", "y", "width", "height", "confidence"],
        propertyOrdering: ["text", "x", "y", "width", "height", "confidence"],
      },
    },
    rationale: {
      type: "string",
      description:
        "One sentence on what you read, or if you returned nothing, what you saw instead.",
    },
  },
  required: ["text", "rationale"],
  propertyOrdering: ["text", "rationale"],
} as const;

/** Bounds as 0..1 fractions of the photo, never pixels. See readBoardText. */
export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrTextItem {
  text: string;
  box: OcrBox;
  /** The model's own certainty, 0..1. Low means it guessed rather than read. */
  confidence: number;
}

export interface OcrResult {
  text: OcrTextItem[];
  meta: {
    model: string;
    latencyMs: number;
    promptTokens: number;
    outputTokens: number;
    /** Items the model returned that could not be placed. See parseOcr. */
    droppedItems: number;
    warnings: string[];
    /** One sentence from the model, worth showing when text comes back empty. */
    rationale: string;
    /** Gemini calls this result cost, retries and the fallback included. */
    attempts: number;
    /** True when `model` is the fallback, not the model the caller asked for. */
    fellBack: boolean;
  };
}

const itemSchema = z.object({
  text: z.string().max(400),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  confidence: z.number().finite().default(0.5),
});

const responseSchema = z.object({
  text: z.array(itemSchema).max(400).default([]),
  rationale: z.string().max(400).default(""),
});

/**
 * How far outside 0..1 a coordinate may sit and still count as rounding.
 *
 * A model that says 1.01 has rounded. One that says 640 is answering in a
 * different unit entirely, and clamping that would stack every label in the
 * bottom-right corner of the board instead of admitting the reading failed.
 */
const SLACK = 0.05;

/**
 * Gemini's own convention for bounding boxes is 0 to 1000, and it falls back to
 * that often enough to matter even under a schema asking for fractions.
 *
 * Rescaling is only safe when the whole response is coherently in that unit,
 * which is what the every() below checks. Keyed off a single stray box instead,
 * one bad item would divide every correctly normalised label by a thousand and
 * pile the board's text into its top-left corner.
 */
const GEMINI_BOX_SCALE = 1000;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const clip = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}...` : text);

type RawItem = z.infer<typeof itemSchema>;

const largestCoord = (item: RawItem) =>
  Math.max(Math.abs(item.x), Math.abs(item.y), Math.abs(item.width), Math.abs(item.height));

/**
 * Validates, then keeps only what can actually be placed on a board.
 *
 * Dropping an unplaceable item rather than clamping it is the point. A box the
 * model put outside the image is a reading it got wrong about position, and a
 * word pinned to the edge of the board is harder for the author to notice and
 * delete than a word that never arrived.
 */
export function parseOcr(raw: unknown): {
  items: OcrTextItem[];
  rationale: string;
  dropped: { items: number; reason: string[] };
} {
  const parsed = responseSchema.parse(raw);
  const reason: string[] = [];

  const largest = parsed.text.map(largestCoord);
  const highest = largest.length > 0 ? Math.max(...largest) : 0;
  // Every item out of range, so none of them is plausibly already a fraction,
  // and something in the hundreds, so the unit is clearly not fractional at all.
  // A response whose largest coordinate is 1.4 is a normalised one that went
  // slightly wrong, and dividing that by a thousand collapses the whole board
  // into its top-left corner.
  const rescale =
    largest.length > 0 &&
    largest.every((value) => value > 1 + SLACK) &&
    highest > GEMINI_BOX_SCALE / 10 &&
    highest <= GEMINI_BOX_SCALE;
  if (rescale) reason.push(`rescaled ${parsed.text.length} boxes from 0..${GEMINI_BOX_SCALE}`);
  const divisor = rescale ? GEMINI_BOX_SCALE : 1;

  const items: OcrTextItem[] = [];
  for (const item of parsed.text) {
    const text = item.text.trim();
    if (!text) {
      reason.push("an item with no text");
      continue;
    }

    const x = item.x / divisor;
    const y = item.y / divisor;
    const width = item.width / divisor;
    const height = item.height / divisor;
    if ([x, y, width, height].some((value) => value < -SLACK || value > 1 + SLACK)) {
      reason.push(`box outside the photo for "${clip(text)}"`);
      continue;
    }

    const left = clamp01(x);
    const top = clamp01(y);
    // Trimmed to the edge rather than left overhanging: the caller multiplies
    // these by the width of the area it drops the trace into, so a box running
    // past 1 would put text outside the board the shapes landed on.
    const box: OcrBox = {
      x: left,
      y: top,
      width: Math.min(clamp01(width), 1 - left),
      height: Math.min(clamp01(height), 1 - top),
    };
    if (box.width <= 0 || box.height <= 0) {
      reason.push(`box with no area for "${clip(text)}"`);
      continue;
    }

    items.push({ text, box, confidence: clamp01(item.confidence) });
  }

  return {
    items,
    rationale: parsed.rationale,
    dropped: { items: parsed.text.length - items.length, reason },
  };
}

interface GenerateArgs {
  imageBase64: string;
  mimeType: string;
  model: string;
  /** Used when `model` is refused for quota reasons. */
  fallbackModel?: string;
  thinking?: ThinkingLevel;
  /**
   * When the caller started, not when this attempt did.
   *
   * It lives in the args so that neither the retry recursion nor the fallback
   * can reset it, which is what makes meta.latencyMs the number the user
   * actually waited rather than the number the last attempt took.
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
 * The route declares `maxDuration = 60`, and overrunning that is not a slow
 * response: the platform kills the function with no body, so the user gets a
 * bare network error instead of any of the messages this file works to produce.
 * The 20s left over covers reading the request, the Supabase round trips and the
 * failure write.
 */
const CHAIN_BUDGET_MS = 40_000;

/** Below this an attempt cannot realistically finish, so do not start one. */
const MIN_ATTEMPT_MS = 3_000;

/** Retries per model, on top of the first attempt. Three calls fit the budget. */
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
 * A proxy or a flaky link resets the socket well before Gemini is involved, and
 * treating that as a hard failure tells the user their photo was unreadable when
 * a single retry would have read it.
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
 * backoff brings it back, so retrying only adds five seconds to an error the
 * user needs to read.
 */
function quotaInfo(error: unknown): { daily: boolean; retryAfterS: number; limit: string } | null {
  const message =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
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
): Promise<OcrResult> {
  const budget = remainingMs(args.started);
  if (budget < MIN_ATTEMPT_MS) {
    throw new Error("Gemini did not answer in time. Try the photo again.");
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
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: args.mimeType, data: args.imageBase64 } },
            {
              text: "Read every piece of writing in this photo of a whiteboard and say where each one sits.",
            },
          ],
        },
      ],
      config: {
        systemInstruction: OCR_SYSTEM,
        // Constrained decoding. Without this the model returns prose around the
        // JSON often enough to matter, and every caller ends up writing a
        // brittle fence-stripping regex.
        responseMimeType: "application/json",
        responseSchema: geminiOcrSchema as unknown as Record<string, unknown>,
        // Low but not zero. At 0 the model repeats the same misreading of an
        // ambiguous word on every retry, so the user has no way to get a
        // different answer out of it. Much higher and it starts paraphrasing
        // what it sees, which is the one thing a transcription must not do.
        temperature: 0.1,
        // A photographed whiteboard can carry sixty labels, and Gemini 3.x
        // reasons before answering out of this same budget. Sized only for the
        // JSON it truncates mid-object, and the response schema does not save
        // you: you get valid-looking partial JSON, which here means half the
        // board's words missing with nothing to say they were ever read.
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
        `Gemini did not answer within ${Math.round(budget / 1000)}s. Try again with a ` +
          `smaller photo, or photograph part of the board.`,
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

  // The dangerous failure. A busy whiteboard runs past maxOutputTokens and the
  // response schema does not save you: the truncated JSON parses, the short list
  // validates, and the board comes back carrying the top half of its labels with
  // nothing to say the rest were ever read. Refuse before any of that can run.
  const finish: string | undefined = response.candidates?.[0]?.finishReason;
  if (finish && finish !== "STOP") {
    throw new Error(
      finish === "MAX_TOKENS"
        ? "That photo had more writing on it than one pass can read. Photograph part of the board and try again."
        : `Gemini stopped early (${finish}), so some of the writing would be missing.`,
    );
  }

  // A prompt-level block returns no candidates at all, so without this it falls
  // through to the empty branch below and reports itself as "Gemini returned an
  // empty response". Naming the block is the difference between "try again" and
  // "retrying this will never work".
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    throw new Error(
      `Gemini refused to read this photo (${blocked}). Crop out the part it is reacting to and try again.`,
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

  const { items, rationale, dropped } = parseOcr(raw);
  const usage = response.usageMetadata;

  return {
    text: items,
    meta: {
      model: args.model,
      latencyMs: Date.now() - args.started,
      promptTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      droppedItems: dropped.items,
      warnings: dropped.reason.slice(0, 5),
      rationale,
      attempts: calls,
      fellBack: progress.fellBack,
    },
  };
}

/**
 * Read the writing off a photo of a whiteboard.
 *
 * Positions come back normalised because the caller scales the traced result on
 * its own, from the vision service's source_width and source_height onto
 * whatever area of the board it drops the shapes into. Pixel coordinates would
 * be right against the photo and wrong against everything downstream of it.
 *
 * An empty list is a real answer, not a failure: a photo of a blank wall has no
 * words on it, and the alternative to saying so is inventing some.
 */
export async function readBoardText(input: {
  /** PNG or JPEG, base64, no data-URL prefix. */
  imageBase64: string;
  mimeType?: string;
  pro?: boolean;
}): Promise<OcrResult> {
  const env = serverEnv();
  return generate({
    started: Date.now(),
    imageBase64: input.imageBase64,
    mimeType: input.mimeType ?? "image/png",
    model: input.pro ? env.geminiModelPro : env.geminiModel,
    fallbackModel: env.geminiModel,
    // Transcription is recognition, not reasoning, and thinking tokens are most
    // of the wall clock a user waits through. The quality toggle is what buys
    // the bigger model and its dynamic thinking, for handwriting that needs it.
    thinking: input.pro ? undefined : ThinkingLevel.MINIMAL,
  });
}
