import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { VisionError, callVision } from "@/lib/vision";

/** Photo of a whiteboard to Excalidraw-ready shape specs, via the OpenCV service. */

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  boardId: z.string().uuid(),
  image: z.string().min(64).max(12_000_000),
  deskew: z.boolean().default(true),
  fitShapes: z.boolean().default(true),
});

interface VisionResponse {
  shapes: unknown[];
  deskewed: boolean;
  source_width: number;
  source_height: number;
  traced_strokes: number;
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
    const result = await callVision<VisionResponse>("/v1/vectorize", {
      image_base64: body.image,
      deskew: body.deskew,
      fit_shapes: body.fitShapes,
    });

    await supabase.from("vision_jobs").insert({
      board_id: body.boardId,
      user_id: auth.user.id,
      kind: "vectorize",
      strokes_in: result.traced_strokes,
      shapes_out: result.shapes.length,
      latency_ms: result.latency_ms,
    });

    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof VisionError ? error.status : 502;
    const message = error instanceof Error ? error.message : "vectorize failed";
    return NextResponse.json({ error: message }, { status });
  }
}
