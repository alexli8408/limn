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

/**
 * How a drawing gets tidied instead of rebuilt.
 *
 * A rebuild is only possible when the sketch has a structure to restate. A house
 * does not, and with nodes and edges as the only vocabulary the one honest
 * answer left was to decline, which made the whole feature conditional on having
 * drawn a flowchart. So the model names the strokes that belong together and
 * says what tidying suits each set, and the compiler derives every coordinate
 * from the elements already on the canvas. Same division of labour as the
 * diagram path: the model reads intent, the code does geometry. It is not asked
 * for a coordinate here either.
 */
export const polishOps = [
  "align-left",
  "align-right",
  "align-top",
  "align-bottom",
  "align-center-x",
  "align-center-y",
  "distribute-x",
  "distribute-y",
  /** One bounding size for every member. */
  "equalize-size",
  /** A wobbly freedraw or line becomes a straight segment. */
  "straighten",
  /** A near-circle becomes a circle, a near-square squares up. */
  "regularize",
  /** Unify strokeWidth, roughness and strokeColor across the members. */
  "match-style",
] as const;

export const polishGroupSchema = z.object({
  /**
   * Ids of elements that are already on the board, unlike diagramNodeSchema.id
   * which the model invents. An invented id names nothing the compiler can move,
   * and pointing at existing elements is the whole reason this payload needs no
   * coordinates in it.
   */
  ids: z.array(z.string().max(128)).max(64).default([]),
  /** What the group is, in the author's words. It is shown to them, so keep it theirs. */
  label: z.string().max(80).default(""),
  /** Empty is a real answer: a group can be worth naming and not worth touching. */
  ops: z.array(z.enum(polishOps)).max(6).default([]),
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
  /**
   * Polish groups over the ids that are already on the canvas.
   *
   * The other half of the answer, and the only half a drawing has. Filled only
   * when kind is "drawing"; parseDiagram clears it otherwise, so a rebuild
   * cannot ask the polish compiler to move elements it is about to replace.
   */
  groups: z.array(polishGroupSchema).max(40).default([]),
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

export type PolishOp = (typeof polishOps)[number];
export type PolishGroup = z.infer<typeof polishGroupSchema>;
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
        "'diagram' when the sketch is boxes/shapes connected by lines or arrows. 'drawing' when it is a picture of something (a person, an object, a scene, a doodle, handwriting) rather than a node-and-edge structure. 'empty' when there is nothing meaningful. Choose 'drawing' whenever you are unsure: returning nodes for a picture destroys the author's work, and a drawing is not refused, it is tidied in place through groups.",
    },
    title: {
      type: "string",
      description:
        "Three to five words naming what this diagram is, in the author's own vocabulary. Used to name their board, so write it as a label, not a sentence: 'Checkout retry flow', not 'A diagram showing the checkout retry flow'.",
    },
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
              // "actor" is deliberately gone. It invited the model to read a
              // drawn person as a node, which is exactly how a stick figure
              // came back as an ellipse labelled "actor". Nothing here should
              // suggest that a picture of something is a diagram element. The
              // wording matches REFINE_SYSTEM so the schema and the prompt
              // cannot disagree about what an ellipse means.
              "rectangle for a step or entity, diamond for a decision. Use an ellipse for a start or end point.",
          },
          emphasis: {
            type: "string",
            enum: [...emphases],
            description:
              "Leave as 'normal' unless the sketch itself marks this node out. It overrides the colour the author drew in, so use it only for a node they clearly signalled: a failure or error path is 'danger', a terminal success is 'success', an aside is 'muted'.",
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
    groups: {
      type: "array",
      // Caps the decoder enforces, so an over-long answer never reaches zod,
      // which throws on one rather than trimming it. Safe here and deliberately
      // absent on nodes: a group the model had to cut short leaves those strokes
      // where the author drew them, while a node list cut short still gets
      // applied, and applying it tombstones every element the missing nodes came
      // from. For structure, failing is the better half of the trade.
      maxItems: "40",
      // The only instructions the model reliably reads for this payload. Kept in
      // step with REFINE_SYSTEM on purpose: the response schema is read at decode
      // time and outranks the system prompt, so a sentence here that contradicts
      // the prompt wins, which is where the stick-figure regression came from.
      description:
        "Fill this ONLY when kind is 'drawing'. Leave it empty for a diagram: a diagram is expressed with nodes and edges instead. A drawing is never rebuilt, it is tidied where it stands, and these groups are how that happens. Split the strokes into the things the picture is made of and name each one the way the author would: 'the house', 'the sun', 'the row of windows'. Group by what the thing IS to them, not by shape type and not by nearness alone: two circles that are the wheels of one car belong together, two circles that merely sit side by side often do not. Use only ids from the element list you were given and never invent one. Every id belongs to at most one group, and a stroke that is not part of anything is better left ungrouped than forced into a group it does not belong to.",
      items: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            maxItems: "64",
            items: { type: "string" },
            description:
              "Ids of the existing elements in this group, taken from the element list. At most 64.",
          },
          label: {
            type: "string",
            description:
              "What this group is, in the author's vocabulary: 'the house', 'the left column'. Name the thing, not the shapes: 'roof', not 'two lines'.",
          },
          ops: {
            type: "array",
            maxItems: "6",
            items: { type: "string", enum: [...polishOps] },
            description:
              "The tidying that suits this group, at most 6. align-left/right/top/bottom snap its members to a shared edge, align-center-x/align-center-y to a shared centre line. distribute-x/distribute-y even out the gaps along one axis. equalize-size gives every member one bounding size. straighten turns a wobbly line or freehand stroke into a straight segment. regularize rounds a near-circle to a circle and squares up a near-square. match-style unifies stroke width, roughness and colour. Choose only what genuinely suits the group; an empty list is a valid answer, and forcing alignment on a deliberately loose sketch makes it worse.",
          },
        },
        required: ["ids", "label", "ops"],
        propertyOrdering: ["ids", "label", "ops"],
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
        "One sentence on what you changed and why. For a drawing, say what you saw and what you tidied, not that you declined.",
    },
  },
  // groups is required for the same reason nodes and edges are: an omitted field
  // decodes as absent, and a drawing that came back without groups would be
  // polished into nothing while reporting success. An empty array is the way to
  // say there is nothing here.
  required: ["kind", "layout", "nodes", "edges", "groups", "rationale"],
  propertyOrdering: ["kind", "title", "layout", "nodes", "edges", "groups", "notes", "rationale"],
} as const;

/**
 * One id, one group.
 *
 * Overlapping groups are a model error with a real consequence: both groups
 * compute a position for the shared element and whichever runs last wins, so the
 * same drawing tidies differently depending on the order the model happened to
 * list them in. First claim keeps the id. A group of one is still kept, since
 * straighten and regularize act on a single stroke; only a group with no ids
 * left is certainly useless.
 */
function claimGroups(groups: PolishGroup[], reason: string[]): PolishGroup[] {
  const claimed = new Set<string>();
  const kept: PolishGroup[] = [];

  for (const group of groups) {
    const ids = group.ids.filter((id) => {
      if (claimed.has(id)) {
        reason.push(`id "${id}" claimed by more than one group`);
        return false;
      }
      claimed.add(id);
      return true;
    });
    if (ids.length === 0) {
      reason.push(`group "${group.label}" has no ids left`);
      continue;
    }
    kept.push({ ...group, ids });
  }

  return kept;
}

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

  // A sketch that is not a diagram must carry no structure through. A model that
  // says "drawing" and still emits nodes would otherwise have those applied
  // anyway, and applying them tombstones the picture they were read from.
  //
  // Groups are the exception, because they are what a drawing gets instead: they
  // move the elements the author already drew rather than replacing them. Only a
  // drawing has any, though. "empty" means there was nothing to name, so a group
  // returned alongside it points at ids that are not there.
  if (diagram.kind !== "diagram") {
    const groups = diagram.kind === "drawing" ? claimGroups(diagram.groups, reason) : [];
    return {
      diagram: { ...diagram, nodes: [], edges: [], notes: [], groups },
      dropped: {
        edges: diagram.edges.length,
        reason: [`sketch classified as "${diagram.kind}"`, ...reason],
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
    // A rebuild replaces the sketch outright, so any group the model volunteered
    // here names elements that are about to be tombstoned. Polishing them would
    // be work against a scene that no longer exists.
    diagram: { ...diagram, edges: unique, groups: [] },
    dropped: { edges: diagram.edges.length - unique.length, reason },
  };
}
