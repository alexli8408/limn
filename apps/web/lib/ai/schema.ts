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

/**
 * What the sketch actually is.
 *
 * Without this the model has no way to refuse. Given a drawing it will map it
 * onto the only vocabulary it has, which is how a stick figure and the word
 * "ball" came back as two ellipses labelled "ball" and "actor". The tool
 * destroyed the sketch to fit its own IR.
 */
export const sketchKinds = ["diagram", "drawing", "empty"] as const;

export const nodeShapes = ["rectangle", "ellipse", "diamond"] as const;
export const emphases = ["normal", "accent", "muted", "success", "danger"] as const;
/**
 * No "grid": the layout engine only knows a flow direction, so plan.ts maps
 * everything that is not layered-lr onto a top-to-bottom Sugiyama pass. Offering
 * the value meant a sketch the model correctly read as a grid came back as a
 * column, which is worse than never having been offered the choice.
 */
export const layouts = ["preserve", "layered-tb", "layered-lr"] as const;

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
  // Defaults to "drawing" so a missing kind fails closed. Defaulting to
  // "diagram" meant a truncated or malformed response was converted anyway, and
  // conversion tombstones the sketch it replaced.
  kind: z.enum(sketchKinds).default("drawing"),
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
    kind: {
      type: "string",
      enum: [...sketchKinds],
      description:
        "'diagram' when the sketch is boxes/shapes connected by lines or arrows. 'drawing' when it is a picture of something (a person, an object, a scene, a doodle, handwriting) rather than a node-and-edge structure. 'empty' when there is nothing meaningful. Choose 'drawing' whenever you are unsure: returning nodes for a picture destroys the author's work.",
    },
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
            // Same wording as REFINE_SYSTEM in gemini.ts. The response schema is read
            // at decode time, so an "actor" offered here outranks a system prompt that
            // bans it, and that is the sentence the stick-figure regression came from.
            description:
              "rectangle for a step or entity, diamond for a decision. Use an ellipse for a start or end point.",
          },
          emphasis: {
            type: "string",
            enum: [...emphases],
            description:
              "Only for a node the author already drew as visually distinct. Use normal otherwise.",
          },
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
      description:
        "One sentence on what you changed and why, or if you declined, what you saw instead.",
    },
  },
  required: ["kind", "layout", "nodes", "edges", "rationale"],
  propertyOrdering: ["kind", "title", "layout", "nodes", "edges", "notes", "rationale"],
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

  // A declined sketch must carry nothing through. A model that says "drawing"
  // and still emits nodes would otherwise have those applied anyway.
  if (diagram.kind !== "diagram") {
    return {
      diagram: { ...diagram, nodes: [], edges: [], notes: [] },
      dropped: {
        edges: diagram.edges.length,
        reason: [`sketch classified as "${diagram.kind}"`],
      },
    };
  }

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
  //
  // Keyed on the pair alone, not the pair plus label. Two edges between the same
  // nodes compile to two arrows on identical coordinates, so a decision diamond
  // whose "yes" and "no" branches both return to one node drew both labels on
  // top of each other and neither was readable. Merging the labels keeps both
  // readings on the single arrow that actually gets drawn.
  const merged = new Map<string, DiagramEdge>();
  const labels = new Map<string, string[]>();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    const seen = labels.get(key);
    if (!seen) {
      merged.set(key, edge);
      labels.set(key, edge.label ? [edge.label] : []);
      continue;
    }
    reason.push(`duplicate edge ${edge.from}->${edge.to}`);
    // An identical label is the model restating itself and adds nothing.
    if (edge.label && !seen.includes(edge.label)) seen.push(edge.label);
  }
  const unique = [...merged].map(([key, edge]) => ({
    ...edge,
    // Sliced to the same 120 the schema allows a single label, so a merge cannot
    // hand the compiler a longer string than the type says is possible.
    label: (labels.get(key) ?? []).join(" / ").slice(0, 120),
  }));

  return {
    diagram: { ...diagram, edges: unique },
    dropped: { edges: diagram.edges.length - unique.length, reason },
  };
}
