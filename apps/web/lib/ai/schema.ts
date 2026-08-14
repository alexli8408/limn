import { z } from "zod";

/**
 * The intermediate representation Gemini is constrained to emit.
 *
 * The model is never asked for Excalidraw elements directly. A raw scene needs
 * `seed`, `versionNonce`, fractional `index`, `boundElements` cross-references
 * and arrow binding focus/gap values to all agree, and a language model will
 * produce something that *looks* right and renders as a pile of unbound arrows.
 *
 * So the model is given a much smaller vocabulary, nodes, edges, labels,
 * grouping, and a deterministic compiler turns that into a valid scene. The
 * model does the part it is good at (reading intent out of a sketch) and none of
 * the part it is bad at (bookkeeping).
 */

export const nodeShapes = ["rectangle", "ellipse", "diamond"] as const;
export const emphases = ["normal", "accent", "muted", "success", "danger"] as const;
export const layouts = ["preserve", "layered-tb", "layered-lr", "grid"] as const;

export const diagramNodeSchema = z.object({
  /** Referenced by edges. The model invents these; they never reach the scene. */
  id: z.string().min(1).max(64),
  label: z.string().max(160).default(""),
  shape: z.enum(nodeShapes).default("rectangle"),
  emphasis: z.enum(emphases).default("normal"),
  /**
   * Ids of the sketched elements this node was recognised from. Present in
   * refine mode, and the whole basis of "same intent": the node is placed where
   * the user drew it, not where a layout algorithm would prefer.
   */
  sourceIds: z.array(z.string().max(128)).max(64).default([]),
  /** Optional layout hint, honoured only when the model asks to recompose. */
  rank: z.number().int().min(0).max(64).optional(),
});

export const diagramEdgeSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  label: z.string().max(120).default(""),
  style: z.enum(["solid", "dashed", "dotted"]).default("solid"),
  directed: z.boolean().default(true),
  sourceIds: z.array(z.string().max(128)).max(64).default([]),
});

export const diagramSchema = z.object({
  title: z.string().max(120).default(""),
  layout: z.enum(layouts).default("preserve"),
  nodes: z.array(diagramNodeSchema).max(120).default([]),
  edges: z.array(diagramEdgeSchema).max(240).default([]),
  /** Free-standing text the model judged to be annotation rather than a node. */
  notes: z
    .array(
      z.object({
        text: z.string().max(400),
        sourceIds: z.array(z.string().max(128)).max(16).default([]),
      }),
    )
    .max(40)
    .default([]),
  /** Shown to the user so an unexpected result is explainable, not magic. */
  rationale: z.string().max(400).default(""),
});

export type DiagramNode = z.infer<typeof diagramNodeSchema>;
export type DiagramEdge = z.infer<typeof diagramEdgeSchema>;
export type LimnDiagram = z.infer<typeof diagramSchema>;

/**
 * The same contract in the OpenAPI subset Gemini accepts as `responseSchema`.
 *
 * Written out rather than derived from the zod schema: the supported subset is
 * narrow (no unions, no defaults, `propertyOrdering` matters for output
 * stability) and a generic converter emits constructs the API rejects. Keeping
 * it explicit also lets the field descriptions carry the instructions, which is
 * where the model actually reads them.
 */
export const geminiDiagramSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short title for the diagram." },
    layout: {
      type: "string",
      enum: [...layouts],
      description:
        "Use 'preserve' to keep the author's spatial arrangement (default for cleaning up a sketch). Only use a layered option if the sketch has no meaningful positions or the user explicitly asked for a re-layout.",
    },
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short unique id, e.g. 'n1'." },
          label: { type: "string", description: "Text inside the node. Keep the author's wording." },
          shape: {
            type: "string",
            enum: [...nodeShapes],
            description:
              "rectangle for a step or entity, diamond for a decision, ellipse for a start/end or actor.",
          },
          emphasis: { type: "string", enum: [...emphases] },
          sourceIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Ids of the input elements this node came from, including its text. Required when layout is 'preserve'.",
          },
        },
        required: ["id", "label", "shape", "sourceIds"],
        propertyOrdering: ["id", "label", "shape", "emphasis", "sourceIds"],
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          label: { type: "string" },
          style: { type: "string", enum: ["solid", "dashed", "dotted"] },
          directed: { type: "boolean" },
          sourceIds: { type: "array", items: { type: "string" } },
        },
        required: ["from", "to", "directed"],
        propertyOrdering: ["from", "to", "label", "style", "directed", "sourceIds"],
      },
    },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          sourceIds: { type: "array", items: { type: "string" } },
        },
        required: ["text"],
        propertyOrdering: ["text", "sourceIds"],
      },
    },
    rationale: {
      type: "string",
      description: "One sentence on what you changed and why.",
    },
  },
  required: ["layout", "nodes", "edges", "rationale"],
  propertyOrdering: ["title", "layout", "nodes", "edges", "notes", "rationale"],
} as const;

/**
 * Validates, then repairs what is safe to repair.
 *
 * Even under a response schema, a model will reference a node id in an edge that
 * it never declared. Dropping those edges is right: they are the model's error,
 * and a dangling arrow is worse than a missing one.
 */
export function parseDiagram(raw: unknown): {
  diagram: LimnDiagram;
  dropped: { edges: number; reason: string[] };
} {
  const diagram = diagramSchema.parse(raw);
  const known = new Set(diagram.nodes.map((n) => n.id));
  const reason: string[] = [];

  const edges = diagram.edges.filter((edge) => {
    if (!known.has(edge.from)) {
      reason.push(`edge from unknown node "${edge.from}"`);
      return false;
    }
    if (!known.has(edge.to)) {
      reason.push(`edge to unknown node "${edge.to}"`);
      return false;
    }
    if (edge.from === edge.to) {
      reason.push(`self-loop on "${edge.from}"`);
      return false;
    }
    return true;
  });

  // Collapse duplicate edges; the model often restates a relationship it already
  // emitted when the sketch draws it twice.
  const seen = new Set<string>();
  const unique = edges.filter((edge) => {
    const key = `${edge.from}->${edge.to}:${edge.label}`;
    if (seen.has(key)) {
      reason.push(`duplicate edge ${edge.from}->${edge.to}`);
      return false;
    }
    seen.add(key);
    return true;
  });

  return {
    diagram: { ...diagram, edges: unique },
    dropped: { edges: diagram.edges.length - unique.length, reason },
  };
}
