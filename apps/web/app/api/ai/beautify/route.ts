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

const MAX_ELEMENTS = 400;
/** Base64 characters, which is what the field actually carries. */
const MAX_IMAGE_CHARS = 8_000_000;

const bodySchema = z.object({
  boardId: z.string().uuid(),
  elements: z.array(elementSchema).min(1).max(MAX_ELEMENTS),
  /** PNG of the selection, base64, no data-URL prefix. */
  image: z.string().min(64).max(MAX_IMAGE_CHARS),
  instruction: z.string().max(500).optional(),
  mode: z.enum(["refine", "recompose"]).default("refine"),
  quality: z.enum(["fast", "high"]).default("fast"),
});

/**
 * The two limits people actually hit, checked before Zod gets a say.
 *
 * Zod states a blown limit as "Array must contain at most 400 element(s)", and
 * that string went straight into the panel. It names no number the user
 * recognises and no action they can take, so it reads as a bug rather than a
 * limit. These two get a sentence of their own instead.
 */
function sizeComplaint(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as { elements?: unknown; image?: unknown };

  if (Array.isArray(body.elements) && body.elements.length > MAX_ELEMENTS) {
    return (
      `This board has ${body.elements.length} elements, more than Beautify reads in one ` +
      `pass. Select the part you want tidied.`
    );
  }
  if (typeof body.image === "string" && body.image.length > MAX_IMAGE_CHARS) {
    const mb = ((body.image.length * 3) / 4 / 1_000_000).toFixed(1);
    return (
      `The picture of this selection came to ${mb}MB, more than one request carries. ` +
      `Select a smaller area and try again.`
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
      console.warn("[limn] beautify rejected a body:", error.issues[0]?.message);
    }
    return NextResponse.json(
      { error: "Beautify could not read that selection. Reload the board and try again." },
      { status: 422 },
    );
  }

  // Re-check write access here rather than trusting the client. The RPC below
  // would enforce it too, but a user without edit rights should not be able to
  // spend a Gemini call at all.
  const { data: canEdit, error: authzError } = await supabase.rpc("can_edit_board", {
    p_board_id: body.boardId,
  });
  if (authzError || !canEdit) {
    return NextResponse.json({ error: "You do not have edit access to this board. Ask the owner for an editor link." }, { status: 403 });
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
      attempts: result.meta.attempts,
      fell_back: result.meta.fellBack,
      prompt_tokens: result.meta.promptTokens,
      output_tokens: result.meta.outputTokens,
      ok: true,
    });

    return NextResponse.json({ diagram: result.diagram, meta: result.meta });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not redraw that selection. Try again.";
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
