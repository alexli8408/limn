import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { illustrateSketch } from "@/lib/ai/gemini";
import { recordGeneration } from "@/lib/ai/usage";

/**
 * Sketch to finished illustration.
 *
 * The result is uploaded to Storage before it comes back, because an Excalidraw
 * image element only carries a `fileId`. The bytes live in the scene's file map,
 * which is not part of the element array and so is not covered by sync. Handing
 * the client a bare data URL would give the author a picture that vanished for
 * every other peer and on their own next reload.
 */

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  boardId: z.string().uuid(),
  /** PNG of the selection, base64, no data-URL prefix. */
  image: z.string().min(64).max(8_000_000),
  instruction: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues[0]?.message : "invalid body";
    return NextResponse.json({ error: detail ?? "invalid body" }, { status: 422 });
  }

  const { data: canEdit } = await supabase.rpc("can_edit_board", { p_board_id: body.boardId });
  if (!canEdit) {
    return NextResponse.json({ error: "no write access to this board" }, { status: 403 });
  }

  try {
    const result = await illustrateSketch({
      imageBase64: body.image,
      instruction: body.instruction,
    });

    // Excalidraw generates its own file ids; this only has to be unique and
    // stable, and it doubles as the storage path.
    const fileId = `limn-${crypto.randomUUID().replace(/-/g, "")}`;
    const bytes = Buffer.from(result.imageBase64, "base64");

    const { error: uploadError } = await supabase.storage
      .from("board-files")
      .upload(`${body.boardId}/${fileId}.png`, bytes, {
        contentType: result.mimeType,
        upsert: true,
      });

    if (uploadError) {
      // The picture is still usable this session even if it will not survive a
      // reload, so this degrades rather than fails.
      console.warn("[limn] illustration upload failed:", uploadError.message);
    }

    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode: "illustrate",
      model: result.model,
      prompt: body.instruction ?? null,
      input_elements: 1,
      output_elements: 1,
      latency_ms: result.latencyMs,
      ok: true,
    });

    return NextResponse.json({
      fileId,
      mimeType: result.mimeType,
      image: result.imageBase64,
      persisted: !uploadError,
      meta: { model: result.model, latencyMs: result.latencyMs, bytes: bytes.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "illustration failed";
    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode: "illustrate",
      model: "image",
      prompt: body.instruction ?? null,
      ok: false,
      error: message.slice(0, 500),
    });
    console.error("[limn] illustrate failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
