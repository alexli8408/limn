import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/env";
import { rewriteText, type RewriteInput } from "@/lib/ai/rewrite";
import { recordGeneration } from "@/lib/ai/usage";

/**
 * Proofreading every text element on a board in one action.
 *
 * Returns only the elements whose text actually changed, each still carrying the
 * id the client sent, so the caller can patch those elements and leave the rest
 * of the board untouched. Applying the edits happens in the browser, where the
 * scene and its versions live.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * More text than one pass can check, and more than the model can answer about
 * before it runs out of output tokens part way through a sentence.
 */
const MAX_ITEMS = 200;
/** Matches the text cap on /api/ai/beautify: the same elements go to both. */
const MAX_TEXT_CHARS = 2000;

const itemSchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().max(MAX_TEXT_CHARS),
});

const bodySchema = z.object({
  boardId: z.string().uuid(),
  items: z.array(itemSchema).min(1).max(MAX_ITEMS),
});

/**
 * The limits people actually hit, checked before Zod gets a say.
 *
 * Zod states a blown cap as "Array must contain at most 200 element(s)", and
 * that string goes straight into the panel. It names no number the user
 * recognises and no action they can take, so it reads as a bug rather than a
 * limit.
 */
function sizeComplaint(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { items } = raw as { items?: unknown };
  if (!Array.isArray(items)) return null;

  if (items.length > MAX_ITEMS) {
    return (
      `This board has ${items.length} pieces of text, more than one pass can check. ` +
      `Select the part you want cleaned up.`
    );
  }
  const long = items.find(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { text?: unknown }).text === "string" &&
      ((item as { text: string }).text.length > MAX_TEXT_CHARS),
  );
  if (long) {
    return (
      `One of these text elements is longer than ${MAX_TEXT_CHARS} characters, more than ` +
      `this checks in one go. Leave that one out of the selection.`
    );
  }
  return null;
}

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const raw: unknown = await request.json();
    const complaint = sizeComplaint(raw);
    if (complaint) return NextResponse.json({ error: complaint }, { status: 422 });
    body = bodySchema.parse(raw);
  } catch (error) {
    // Anything Zod has left to say names fields the user has never seen, so it
    // goes to the log and they get a sentence they can act on.
    if (error instanceof z.ZodError) {
      console.warn("[limn] rewrite rejected a body:", error.issues[0]?.message);
    }
    return NextResponse.json(
      { error: "That text could not be read. Reload the board and try again." },
      { status: 422 },
    );
  }

  // Re-checked here rather than trusted from the client, and edit rather than
  // read: this rewrites the author's own elements, so a viewer must not be able
  // to start it, let alone spend a Gemini call doing so.
  const { data: canEdit, error: authzError } = await supabase.rpc("can_edit_board", {
    p_board_id: body.boardId,
  });
  if (authzError || !canEdit) {
    return NextResponse.json({ error: "You do not have edit access to this board. Ask the owner for an editor link." }, { status: 403 });
  }

  const items: RewriteInput[] = body.items;

  // "refine" is the closest label ai_mode has. There is no rewrite value in the
  // enum and adding one is a migration, so tidying text lands in the counters
  // beside the other tidy-what-is-already-there mode rather than under a mode
  // that does not exist.
  const mode = "refine" as const;

  try {
    const result = await rewriteText({
      items,
      // Handed on so a user who closes the tab stops the call instead of paying
      // for an answer nobody is left to read.
      signal: request.signal,
    });

    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode,
      model: result.meta.model,
      input_elements: items.length,
      // Corrections, not elements written: most of a checked board comes back
      // unchanged, and that is the successful outcome rather than a small one.
      output_elements: result.edits.length,
      latency_ms: result.meta.latencyMs,
      attempts: result.meta.attempts,
      fell_back: result.meta.fellBack,
      prompt_tokens: result.meta.promptTokens,
      output_tokens: result.meta.outputTokens,
      ok: true,
    });

    return NextResponse.json({ edits: result.edits, meta: result.meta });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not check the text. Try again.";

    // A user who navigated away is not a failure of this route. Writing a row
    // for it would count their hang-up against the board's error rate, and
    // there is nobody left to read the body either way.
    if (request.signal.aborted) {
      return NextResponse.json({ error: message }, { status: 499 });
    }

    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode,
      // The real model id, not the "flash" label the routes with a quality
      // toggle write here. Proofreading has no toggle and no fallback, so the
      // model that failed is exactly the one a successful row would name, and
      // guessing at a shorthand instead would leave this mode's failures
      // counted against a model that appears in none of its successes.
      model: serverEnv().geminiModel,
      input_elements: items.length,
      ok: false,
      error: message.slice(0, 500),
    });
    console.error("[limn] rewrite failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
