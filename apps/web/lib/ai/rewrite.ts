import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { serverEnv } from "@/lib/env";

/**
 * Proofreading every piece of text on a board in one pass.
 *
 * Typing on a whiteboard is fast and sloppy by design, so a board that has been
 * worked on for an hour carries a scattering of typos nobody wants to click
 * through one at a time. This is the one action that fixes the lot.
 *
 * What it must not do is the whole difficulty. The result is written straight
 * back onto the author's own elements, where a changed word looks exactly like a
 * word they typed, so anything beyond a mechanical correction is a bug that
 * hides itself. The prompt, the response schema and parseRewrite all narrow the
 * same way: only real changes come back, only for ids we handed out.
 *
 * Server-side only, like lib/ai/gemini.ts. Importing this from a client
 * component would put GEMINI_API_KEY in the browser bundle.
 *
 * The client accessor and the failure classification below are copies of the
 * ones in lib/ai/gemini.ts, which keeps them module-private, and lib/ai/ocr.ts
 * carries the same copies for the same reason. Three copies is one too many: if
 * they are ever exported, import them here instead of keeping them in step.
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

const REWRITE_SYSTEM = `You are proofreading the text on someone's whiteboard.

You get a list of items, each with an id and the text exactly as the author
typed it. Return an entry only for the items you actually changed.

Fix only mechanical mistakes:
- misspellings and typos: "teh" to "the", "recieve" to "receive"
- a capital missing from the start of a sentence or a proper noun
- doubled spaces, a space before a comma, a missing space after a full stop
- a word left doubled by an edit, like "the the"
- obvious slips of the keyboard

Never do any of these:
- reword, rephrase, shorten or expand anything
- expand an abbreviation or a shorthand. "auth svc" stays "auth svc"
- translate
- add or remove punctuation the author chose, including putting a full stop on
  the end of a label that has none
- change a heading written in CAPITALS, or a label written all in lower case.
  That is how the board is styled, not a mistake, and correcting it is the way
  this task usually goes wrong
- touch code, identifiers, file names, URLs, or anything in quotes

Return the corrected text in full rather than a description of the change, and
copy the id back exactly as it was given to you. An item that is already
correct is left out of the list entirely.

Getting this wrong is worse than doing nothing. The author cannot see what you
changed, so a sentence they did not write reads as the board editing itself.
If you are not sure something is a mistake, it is not a mistake.`;

/**
 * The same contract in the OpenAPI subset Gemini accepts as `responseSchema`.
 *
 * Flat id/text rather than anything richer. There is no room here for the model
 * to explain itself per item, and offering it a field to do so is an invitation
 * to justify a rewording rather than not make one.
 */
export const geminiRewriteSchema = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The id of the item you corrected, copied exactly from the input.",
          },
          text: {
            type: "string",
            description:
              "The author's own words with only mechanical errors fixed, in full. Never reworded, expanded or translated.",
          },
        },
        required: ["id", "text"],
        propertyOrdering: ["id", "text"],
      },
    },
    rationale: {
      type: "string",
      description:
        "One sentence on what you corrected, or if you corrected nothing, why the text was already fine.",
    },
  },
  required: ["edits", "rationale"],
  propertyOrdering: ["edits", "rationale"],
} as const;

/** One text element as it currently reads on the board. */
export interface RewriteInput {
  id: string;
  text: string;
}

/** A correction for one element. Only elements that actually change appear. */
export interface RewriteEdit {
  id: string;
  text: string;
}

export interface RewriteResult {
  edits: RewriteEdit[];
  meta: {
    model: string;
    latencyMs: number;
    promptTokens: number;
    outputTokens: number;
    /** Entries the model returned that were refused. See parseRewrite. */
    droppedItems: number;
    warnings: string[];
    /** One sentence from the model, worth showing when nothing changed. */
    rationale: string;
    /** Gemini calls this result cost. Zero when the board had no text to check. */
    attempts: number;
    /**
     * Always false. Proofreading runs on the one model with no quality toggle
     * and nothing to fall back to, but the usage row records fell_back for every
     * mode, so the field is here rather than left for the route to invent.
     */
    fellBack: boolean;
  };
}

const editSchema = z.object({
  // Unbounded for the same reason as text below, and it is the likelier of the
  // two to arrive over-long: a model that has lost track of the input runs two
  // ids together. The loop refuses that entry on its own, because no such id was
  // ever sent, and the id is clipped before it reaches a warning.
  id: z.string(),
  // Deliberately unbounded, unlike every other string in this file. A single
  // over-long entry is dropped by the loop below with the rest of the response
  // kept; a max() here would throw out every good correction alongside it.
  text: z.string(),
});

const responseSchema = z.object({
  edits: z.array(editSchema).max(400).default([]),
  rationale: z.string().max(400).default(""),
});

/**
 * How far text may grow before the change stops looking like a correction.
 *
 * A coarse net, and it is meant to be: it catches a label that came back as a
 * sentence, which is the failure that ruins a board. It will not catch one
 * expanded abbreviation, and it is not trying to. That is the prompt's job.
 */
const MAX_GROWTH = 2;
const GROWTH_SLACK = 16;

const clip = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}...` : text);

/**
 * Validates, then keeps only the entries that are safe to write to the board.
 *
 * Every rule here is about what reaches the author's elements. An id we did not
 * send is a correction to something we never showed the model, empty text
 * deletes a label outright, and text identical to the input is not an edit at
 * all: passing it through would bump the version of an element nothing happened
 * to, which is what makes an untouched label look edited in the history.
 */
export function parseRewrite(
  raw: unknown,
  /** Original text by id, exactly as it was sent. */
  originals: ReadonlyMap<string, string>,
): {
  edits: RewriteEdit[];
  rationale: string;
  dropped: { items: number; reason: string[] };
} {
  const parsed = responseSchema.parse(raw);
  const reason: string[] = [];
  const edits: RewriteEdit[] = [];
  const seen = new Set<string>();

  for (const edit of parsed.edits) {
    const before = originals.get(edit.id);
    if (before === undefined) {
      reason.push(`an edit for "${clip(edit.id)}", which was not sent`);
      continue;
    }
    // Checked before the duplicate rule below, not after it. Text identical to
    // the input is the model listing an item it left alone, which is not an
    // edit and must not claim the id: a model that echoes an item and then
    // corrects it would otherwise have its correction refused as a second
    // opinion, leaving the typo on the board and reporting nothing wrong.
    //
    // Identical after trimming counts as identical too. A space added or
    // dropped at the end of a label corrects nothing the author can see, and
    // writing it back bumps the element's version for it. Spacing inside the
    // text is a real fix and survives this: "a  b" and "a b" still differ.
    if (edit.text === before || edit.text.trim() === before.trim()) continue;

    // A second entry for the same id means the model corrected it twice and
    // disagreed with itself. The caller applies one edit per element, so
    // without this the later entry would quietly overwrite the earlier one and
    // which correction landed would depend on the order they came back in.
    if (seen.has(edit.id)) {
      reason.push(`a second edit for "${clip(before)}"`);
      continue;
    }
    seen.add(edit.id);

    if (!edit.text.trim()) {
      reason.push(`an empty replacement for "${clip(before)}"`);
      continue;
    }
    if (edit.text.length > before.length * MAX_GROWTH + GROWTH_SLACK) {
      reason.push(`"${clip(before)}" came back rewritten rather than corrected`);
      continue;
    }

    edits.push({ id: edit.id, text: edit.text });
  }

  return {
    edits,
    rationale: parsed.rationale,
    // One reason per refusal, so the count is the reasons. Deliberately not
    // `parsed.edits.length - edits.length`: an entry the model returned
    // unchanged is the expected answer for most of a board, and counting those
    // as drops would report a clean board as a broken one.
    dropped: { items: reason.length, reason },
  };
}

interface GenerateArgs {
  items: RewriteInput[];
  originals: ReadonlyMap<string, string>;
  model: string;
  /** The caller's cancellation, kept apart from our own deadline. */
  signal?: AbortSignal;
  /**
   * When the caller started, not when this attempt did.
   *
   * It lives in the args so that neither the retry recursion nor a backoff can
   * reset it, which is what makes meta.latencyMs the number the user actually
   * waited rather than the number the last attempt took.
   */
  started: number;
}

/** Counters that have to survive the recursion, unlike the args. */
interface Progress {
  /** Retries already spent. */
  attempt: number;
  /** Every generateContent call so far. */
  calls: number;
}

/** Codes worth retrying rather than surfacing. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/**
 * Ceiling on one call to generate(), retries included.
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

/** Retries on top of the first attempt. Three calls fit the budget. */
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
 * treating that as a hard failure tells the user their board could not be read
 * when a single retry would have read it.
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

/** Thrown when the caller hung up, so the route can tell it apart from a fault. */
const cancelled = () => new Error("The rewrite was cancelled before it finished.");

async function generate(
  args: GenerateArgs,
  progress: Progress = { attempt: 0, calls: 0 },
): Promise<RewriteResult> {
  if (args.signal?.aborted) throw cancelled();

  const budget = remainingMs(args.started);
  if (budget < MIN_ATTEMPT_MS) {
    throw new Error("Gemini did not answer in time. Try the board again.");
  }
  const calls = progress.calls + 1;

  // Held rather than inlined so the catch can ask each signal whether it fired.
  // An aborted fetch is wrapped differently depending on how far the request
  // got, and guessing at the error shape is how a spent deadline ends up being
  // retried as though it were a flaky socket. The caller's signal is combined
  // rather than merged into one: a user who navigated away and a deadline that
  // ran out want different messages, and only the signals can tell them apart.
  const deadline = AbortSignal.timeout(budget);
  const abort = args.signal ? AbortSignal.any([deadline, args.signal]) : deadline;

  let response;
  try {
    response = await ai().models.generateContent({
      model: args.model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                `Text items (${args.items.length}):`,
                JSON.stringify(args.items),
                "Return an entry only for the ones you corrected.",
              ].join("\n\n"),
            },
          ],
        },
      ],
      config: {
        systemInstruction: REWRITE_SYSTEM,
        // Constrained decoding. Without this the model returns prose around the
        // JSON often enough to matter, and every caller ends up writing a
        // brittle fence-stripping regex.
        responseMimeType: "application/json",
        responseSchema: geminiRewriteSchema as unknown as Record<string, unknown>,
        // Low but not zero. At 0 the model repeats the same misreading of an
        // ambiguous word on every retry, so the user has no way to get a
        // different answer out of it. Much higher and it starts improving
        // phrasing, which is the one thing proofreading must not do.
        temperature: 0.1,
        // A worked-on board carries a lot of text and Gemini 3.x reasons before
        // answering out of this same budget. Sized only for the JSON it
        // truncates mid-object, and the response schema does not save you: the
        // partial JSON parses and the last edit in it carries half a sentence,
        // which would land on the board as text the author never wrote.
        maxOutputTokens: 16384,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        // Per attempt, not per chain. A hung socket produces no status code and
        // no error at all, so without this the request sits there until the
        // platform kills the whole function and none of the handling below runs.
        abortSignal: abort,
      },
    });
  } catch (error) {
    // Checked before the deadline: when both have fired, the user walking away
    // is the reason that matters, and retrying anything for them is waste.
    if (args.signal?.aborted) throw cancelled();

    // Our own deadline, not anything Gemini said, so no status code applies.
    // Retrying it is pointless: firing at all means the budget is spent.
    if (deadline.aborted) {
      throw new Error(
        `Gemini did not answer within ${Math.round(budget / 1000)}s. Try again with ` +
          `fewer text elements selected.`,
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
      return generate(args, { attempt: progress.attempt + 1, calls });
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

  // The dangerous failure. A board with a lot of text runs past maxOutputTokens
  // and the response schema does not save you: the truncated JSON parses, the
  // short list validates, and whatever edit was mid-flight when the budget ran
  // out lands on the board as a half-finished sentence. Refuse before any of
  // that can be written back.
  const finish: string | undefined = response.candidates?.[0]?.finishReason;
  if (finish && finish !== "STOP") {
    throw new Error(
      finish === "MAX_TOKENS"
        ? "That board has more text on it than one pass can check. Select part of it and try again."
        : `Gemini stopped early (${finish}), so some of the corrections would be half written.`,
    );
  }

  // A prompt-level block returns no candidates at all, so without this it falls
  // through to the empty branch below and reports itself as "Gemini returned an
  // empty response". Naming the block is the difference between "try again" and
  // "retrying this will never work".
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    throw new Error(
      `Gemini refused to read this board (${blocked}). Deselect the text it is reacting to and try again.`,
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

  const { edits, rationale, dropped } = parseRewrite(raw, args.originals);
  const usage = response.usageMetadata;

  return {
    edits,
    meta: {
      model: args.model,
      latencyMs: Date.now() - args.started,
      promptTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      droppedItems: dropped.items,
      warnings: dropped.reason.slice(0, 5),
      rationale,
      attempts: calls,
      fellBack: false,
    },
  };
}

/**
 * Clean up the spelling, casing and spacing of a board's text in one pass.
 *
 * Only changed text comes back. The caller applies each edit to the element it
 * names and bumps that element's version, so an item missing from the result
 * means "nothing to do here", not "this one failed": handing back unchanged text
 * would mark elements as edited that nobody touched.
 *
 * An empty list is a real answer. Most boards are mostly fine.
 */
export async function rewriteText(input: {
  items: RewriteInput[];
  /** The caller hanging up, usually a route passing on `request.signal`. */
  signal?: AbortSignal;
}): Promise<RewriteResult> {
  const env = serverEnv();

  // First id wins, and blank items never go out at all. Both are here rather
  // than in the route because they decide what the model is allowed to answer
  // about: a duplicate id makes two originals for one key, and there is nothing
  // to proofread in an empty label.
  const originals = new Map<string, string>();
  const items: RewriteInput[] = [];
  for (const item of input.items) {
    if (!item.text.trim() || originals.has(item.id)) continue;
    originals.set(item.id, item.text);
    items.push({ id: item.id, text: item.text });
  }

  // No call at all rather than a call that can only answer "nothing". attempts
  // of 0 is what tells the usage row that this cost nothing.
  if (items.length === 0) {
    return {
      edits: [],
      meta: {
        model: env.geminiModel,
        latencyMs: 0,
        promptTokens: 0,
        outputTokens: 0,
        droppedItems: 0,
        warnings: [],
        rationale: "There is no text on this board to check.",
        attempts: 0,
        fellBack: false,
      },
    };
  }

  return generate({
    started: Date.now(),
    items,
    originals,
    // No quality toggle and no fallback model. Proofreading is recognition
    // rather than reasoning, and the pro model spends most of a user's wait on
    // thinking tokens to arrive at the same corrections.
    model: env.geminiModel,
    signal: input.signal,
  });
}
