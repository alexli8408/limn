import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { refineSketch, type SketchElement } from "@/lib/ai/gemini";
import { recordGeneration } from "@/lib/ai/usage";

/**
 * Sketch beautification.
 *
 * Returns a LimnDiagram, not Excalidraw elements. Compilation happens in the
 * browser because it calls `convertToExcalidrawElements`, which lives in the
 * canvas bundle, a package with DOM assumptions that has no business being
 * pulled into a serverless function.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const elementSchema = z.object({
  id: z.string().max(128),
  type: z.string().max(32),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  text: z.string().max(2000).optional(),
  containerId: z.string().max(128).nullable().optional(),
  strokeColor: z.string().max(32).optional(),
});

const bodySchema = z.object({
  boardId: z.string().uuid(),
  elements: z.array(elementSchema).min(1).max(400),
  /** PNG of the selection, base64, no data-URL prefix. */
  image: z.string().min(64).max(8_000_000),
  instruction: z.string().max(500).optional(),
  mode: z.enum(["refine", "recompose"]).default("refine"),
  quality: z.enum(["fast", "high"]).default("fast"),
});

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues[0]?.message : "invalid body";
    return NextResponse.json({ error: detail ?? "invalid body" }, { status: 422 });
  }

  // Re-check write access here rather than trusting the client. The RPC below
  // would enforce it too, but a user without edit rights should not be able to
  // spend a Gemini call at all.
  const { data: canEdit, error: authzError } = await supabase.rpc("can_edit_board", {
    p_board_id: body.boardId,
  });
  if (authzError || !canEdit) {
    return NextResponse.json({ error: "no write access to this board" }, { status: 403 });
  }

  const elements: SketchElement[] = body.elements;

  try {
    const result = await refineSketch({
      elements,
      imageBase64: body.image,
      instruction: body.instruction,
      recompose: body.mode === "recompose",
      pro: body.quality === "high",
    });

    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode: body.mode,
      model: result.meta.model,
      prompt: body.instruction ?? null,
      input_elements: elements.length,
      output_elements: result.diagram.nodes.length + result.diagram.edges.length,
      latency_ms: result.meta.latencyMs,
      prompt_tokens: result.meta.promptTokens,
      output_tokens: result.meta.outputTokens,
      ok: true,
    });

    return NextResponse.json({ diagram: result.diagram, meta: result.meta });
  } catch (error) {
    const message = error instanceof Error ? error.message : "generation failed";
    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode: body.mode,
      model: body.quality === "high" ? "pro" : "flash",
      input_elements: elements.length,
      ok: false,
      error: message.slice(0, 500),
    });
    console.error("[limn] beautify failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
