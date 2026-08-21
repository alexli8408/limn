import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { readBoardText } from "@/lib/ai/ocr";
import { recordGeneration } from "@/lib/ai/usage";

/**
 * The words on a photographed whiteboard.
 *
 * Runs beside /api/vision/vectorize on the same photo, not after it: the OpenCV
 * pipeline traces ink into shapes and reads none of it, so without this a board
 * of labelled boxes arrives as boxes with nothing written in them. Positions
 * come back as 0..1 fractions of the photo, because the caller scales the traced
 * shapes on its own and pixel coordinates would not survive that.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Base64 characters, which is what the field actually carries.
 *
 * Matched to the cap on /api/vision/vectorize deliberately. The two routes are
 * handed the same photo, and a lower limit here means a picture that traces
 * perfectly well comes back with every one of its labels missing.
 */
const MAX_IMAGE_CHARS = 12_000_000;

const bodySchema = z.object({
  boardId: z.string().uuid(),
  /** PNG or JPEG of the photo, base64, no data-URL prefix. */
  image: z.string().min(64).max(MAX_IMAGE_CHARS),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).default("image/png"),
  quality: z.enum(["fast", "high"]).default("fast"),
});

/**
 * The limit people actually hit, checked before Zod gets a say.
 *
 * Zod states a blown cap as "String must contain at most 12000000 character(s)",
 * and that string goes straight into the panel. It names no number the user
 * recognises and no action they can take, so it reads as a bug rather than a
 * limit.
 */
function sizeComplaint(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { image } = raw as { image?: unknown };
  if (typeof image !== "string" || image.length <= MAX_IMAGE_CHARS) return null;

  const mb = ((image.length * 3) / 4 / 1_000_000).toFixed(1);
  return (
    `That photo came to ${mb}MB, more than one request carries. Take it again at a ` +
    `lower resolution, or photograph part of the board.`
  );
}

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
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
      console.warn("[limn] ocr rejected a body:", error.issues[0]?.message);
    }
    return NextResponse.json(
      { error: "That photo could not be read. Reload the board and try again." },
      { status: 422 },
    );
  }

  // Re-checked here rather than trusted from the client. The insert below would
  // enforce it too, but a user without edit rights should not be able to spend a
  // Gemini call at all.
  const { data: canEdit, error: authzError } = await supabase.rpc("can_edit_board", {
    p_board_id: body.boardId,
  });
  if (authzError || !canEdit) {
    return NextResponse.json({ error: "no write access to this board" }, { status: 403 });
  }

  // "vectorize" is the closest label ai_mode has. There is no OCR value in the
  // enum and adding one is a migration, so photo text lands in the counters
  // beside the trace it belongs to rather than under a mode that does not exist.
  const mode = "vectorize" as const;

  try {
    const result = await readBoardText({
      imageBase64: body.image,
      mimeType: body.mimeType,
      pro: body.quality === "high",
    });

    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode,
      model: result.meta.model,
      // One photo in, however many words out. input_elements counts board
      // elements and a photo is not one, so it stays at zero rather than
      // carrying a number that means something else in every other row.
      output_elements: result.text.length,
      latency_ms: result.meta.latencyMs,
      attempts: result.meta.attempts,
      fell_back: result.meta.fellBack,
      prompt_tokens: result.meta.promptTokens,
      output_tokens: result.meta.outputTokens,
      ok: true,
    });

    return NextResponse.json({ text: result.text, meta: result.meta });
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not read the photo";
    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode,
      model: body.quality === "high" ? "pro" : "flash",
      ok: false,
      error: message.slice(0, 500),
    });
    console.error("[limn] ocr failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
