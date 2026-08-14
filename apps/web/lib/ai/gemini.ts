import { GoogleGenAI } from "@google/genai";
import { serverEnv } from "@/lib/env";
import { geminiDiagramSchema, parseDiagram, type LimnDiagram } from "./schema";

/**
 * Server-side Gemini access. Never import this from a client component — the
 * API key would end up in the browser bundle.
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

/** Element fields the model needs. The rest is noise that costs input tokens. */
export interface SketchElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  containerId?: string | null;
  strokeColor?: string;
}

const REFINE_SYSTEM = `You read hand-drawn whiteboard sketches and describe what the author meant.

You are given a rendered image of a sketch and a list of its elements with ids
and positions. Return a structured diagram describing the same content.

Rules:
- Preserve the author's intent exactly. Do not add steps, rename things, or
  invent structure that is not in the sketch.
- Every node must list the ids of the input elements it came from, in sourceIds,
  including the id of any text element that labels it.
- Keep the author's own wording for labels, including abbreviations. Fix only
  clear spelling slips.
- Read a diamond as a decision, an ellipse as a start/end or an actor, and a
  rectangle as a step or entity. If a shape is ambiguous, choose by its role in
  the diagram rather than by how it was drawn.
- Lines and arrows between shapes are edges. An arrowhead means directed; a plain
  line between two shapes is usually directed along the reading order, but say
  directed: false if the sketch clearly shows a plain association.
- Text that labels nothing in particular is a note, not a node.
- Use layout "preserve" unless the sketch has no meaningful arrangement.`;

const PROMPT_SYSTEM = `You turn a short description into a clean diagram.

Rules:
- Choose the smallest set of nodes that expresses the idea. Prefer 4 to 9.
- Label nodes with short noun phrases, not sentences.
- Use a diamond for a decision, an ellipse for a start or end, a rectangle
  otherwise.
- Use layout "layered-tb" for a process or flow, "layered-lr" for a pipeline or
  a sequence of stages.
- Leave sourceIds empty; there is no existing sketch.
- Use emphasis sparingly, to mark at most one or two focal nodes.`;

export interface GenerateResult {
  diagram: LimnDiagram;
  meta: {
    model: string;
    latencyMs: number;
    promptTokens: number;
    outputTokens: number;
    droppedEdges: number;
    warnings: string[];
  };
}

interface GenerateArgs {
  system: string;
  parts: Record<string, unknown>[];
  model: string;
  temperature: number;
}

async function generate(args: GenerateArgs): Promise<GenerateResult> {
  const started = Date.now();

  const response = await ai().models.generateContent({
    model: args.model,
    contents: [{ role: "user", parts: args.parts }],
    config: {
      systemInstruction: args.system,
      // Constrained decoding. Without this the model returns prose around the
      // JSON often enough to matter, and every caller ends up writing a brittle
      // fence-stripping regex.
      responseMimeType: "application/json",
      responseSchema: geminiDiagramSchema as unknown as Record<string, unknown>,
      temperature: args.temperature,
      maxOutputTokens: 8192,
    },
  });

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned malformed JSON despite a response schema");
  }

  const { diagram, dropped } = parseDiagram(raw);
  const usage = response.usageMetadata;

  return {
    diagram,
    meta: {
      model: args.model,
      latencyMs: Date.now() - started,
      promptTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      droppedEdges: dropped.edges,
      warnings: dropped.reason.slice(0, 5),
    },
  };
}

/**
 * Beautify a sketch. The rendered image carries the spatial relationships that a
 * flat element list does not — which arrow points at which box is obvious in a
 * picture and genuinely ambiguous in coordinates alone — so both are sent.
 */
export async function refineSketch(input: {
  elements: SketchElement[];
  imageBase64: string;
  instruction?: string;
  recompose?: boolean;
  pro?: boolean;
}): Promise<GenerateResult> {
  const env = serverEnv();
  const parts: Record<string, unknown>[] = [
    { inlineData: { mimeType: "image/png", data: input.imageBase64 } },
    {
      text: [
        `Elements (${input.elements.length}):`,
        JSON.stringify(input.elements),
        input.recompose
          ? 'The author asked for a re-layout. Set layout to "layered-tb" or "layered-lr" and still fill in sourceIds so their sketch can be replaced.'
          : 'Set layout to "preserve".',
        input.instruction ? `Author's instruction: ${input.instruction}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  return generate({
    system: REFINE_SYSTEM,
    parts,
    model: input.pro ? env.geminiModelPro : env.geminiModel,
    // Low but not zero: at 0 the model repeats a bad reading of an ambiguous
    // sketch on every retry, so the user has no way to get a different answer.
    temperature: 0.2,
  });
}

/** Text to diagram. No sketch to preserve, so the layout engine does the placing. */
export async function diagramFromPrompt(input: {
  prompt: string;
  pro?: boolean;
}): Promise<GenerateResult> {
  const env = serverEnv();
  return generate({
    system: PROMPT_SYSTEM,
    parts: [{ text: input.prompt }],
    model: input.pro ? env.geminiModelPro : env.geminiModel,
    temperature: 0.4,
  });
}
