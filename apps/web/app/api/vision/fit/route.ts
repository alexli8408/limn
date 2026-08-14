import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { VisionError, callVision } from "@/lib/vision";

/**
 * Deep stroke fitting.
 *
 * The browser already snaps shapes locally within a frame; this is the pass for
 * strokes it declined, drawn in several overlapping passes, or self-crossing,
 * where OpenCV's fill-then-contour approach still reads the intent.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  boardId: z.string().uuid(),
  strokes: z
    .array(
      z.object({
        id: z.string().max(128),
        points: z.array(z.array(z.number()).min(2).max(3)).min(2).max(20_000),
      }),
    )
    .min(1)
    .max(200),
  minConfidence: z.number().min(0).max(1).default(0.55),
});

interface FitResponse {
  results: unknown[];
  recognised: number;
  latency_ms: number;
}

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 422 });
  }

  const { data: canEdit } = await supabase.rpc("can_edit_board", {
    p_board_id: body.boardId,
  });
  if (!canEdit) {
    return NextResponse.json({ error: "no write access to this board" }, { status: 403 });
  }

  try {
    const result = await callVision<FitResponse>(
      "/v1/strokes/fit",
      { strokes: body.strokes, min_confidence: body.minConfidence },
      30_000,
    );

    await supabase.from("vision_jobs").insert({
      board_id: body.boardId,
      user_id: auth.user.id,
      kind: "fit",
      strokes_in: body.strokes.length,
      shapes_out: result.recognised,
      latency_ms: result.latency_ms,
    });

    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof VisionError ? error.status : 502;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "fit failed" },
      { status },
    );
  }
}
