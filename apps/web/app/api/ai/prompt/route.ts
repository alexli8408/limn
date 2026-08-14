import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { diagramFromPrompt } from "@/lib/ai/gemini";
import { recordGeneration } from "@/lib/ai/usage";

/** Text to diagram. Placement is left to the deterministic layout engine. */

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  boardId: z.string().uuid(),
  prompt: z.string().min(3).max(2000),
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

  const { data: canEdit } = await supabase.rpc("can_edit_board", {
    p_board_id: body.boardId,
  });
  if (!canEdit) {
    return NextResponse.json({ error: "no write access to this board" }, { status: 403 });
  }

  try {
    const result = await diagramFromPrompt({
      prompt: body.prompt,
      pro: body.quality === "high",
    });

    // The model is told to pick a layered layout, but "preserve" makes no sense
    // with no sketch to preserve, there would be nothing to derive geometry from.
    const diagram =
      result.diagram.layout === "preserve"
        ? { ...result.diagram, layout: "layered-tb" as const }
        : result.diagram;

    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode: "prompt",
      model: result.meta.model,
      prompt: body.prompt.slice(0, 2000),
      output_elements: diagram.nodes.length + diagram.edges.length,
      latency_ms: result.meta.latencyMs,
      prompt_tokens: result.meta.promptTokens,
      output_tokens: result.meta.outputTokens,
      ok: true,
    });

    return NextResponse.json({ diagram, meta: result.meta });
  } catch (error) {
    const message = error instanceof Error ? error.message : "generation failed";
    await recordGeneration(supabase, {
      board_id: body.boardId,
      user_id: auth.user.id,
      mode: "prompt",
      model: body.quality === "high" ? "pro" : "flash",
      prompt: body.prompt.slice(0, 2000),
      ok: false,
      error: message.slice(0, 500),
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
