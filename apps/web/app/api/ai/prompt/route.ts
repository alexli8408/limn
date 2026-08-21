import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { diagramFromPrompt } from "@/lib/ai/gemini";
import { recordGeneration } from "@/lib/ai/usage";

/** Text to diagram. Placement is left to the deterministic layout engine. */

export const runtime = "nodejs";
export const maxDuration = 60;

const MIN_PROMPT = 3;
const MAX_PROMPT = 2000;

const bodySchema = z.object({
  boardId: z.string().uuid(),
  prompt: z.string().min(MIN_PROMPT).max(MAX_PROMPT),
  quality: z.enum(["fast", "high"]).default("fast"),
});

/**
 * The prompt length, checked before Zod gets a say.
 *
 * Zod states it as "String must contain at most 2000 character(s)", and that
 * string went straight into the panel, where it reads as a bug rather than a
 * limit and says nothing about what to do next.
 */
function promptComplaint(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { prompt } = raw as { prompt?: unknown };
  if (typeof prompt !== "string") return null;

  if (prompt.trim().length < MIN_PROMPT) {
    return "Describe the diagram you want first, even in a few words.";
  }
  if (prompt.length > MAX_PROMPT) {
    return (
      `That description is ${prompt.length} characters, more than one request carries. ` +
      `Cut it to ${MAX_PROMPT} or fewer and describe only the structure you want.`
    );
  }
  return null;
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
    const complaint = promptComplaint(raw);
    if (complaint) return NextResponse.json({ error: complaint }, { status: 422 });
    body = bodySchema.parse(raw);
  } catch (error) {
    // Anything Zod has left to say names fields the user has never seen, so it
    // goes to the log and they get a sentence they can act on.
    if (error instanceof z.ZodError) {
      console.warn("[limn] prompt rejected a body:", error.issues[0]?.message);
    }
    return NextResponse.json(
      { error: "That request could not be read. Reload the board and try again." },
      { status: 422 },
    );
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
      attempts: result.meta.attempts,
      fell_back: result.meta.fellBack,
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
