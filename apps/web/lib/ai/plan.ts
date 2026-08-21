import { alignBoxes, type Box } from "@limn/shapes";
import type { SyncElement } from "@limn/protocol";
import { layoutDiagram, type LayoutBox } from "./layout";
import type { LimnDiagram } from "./schema";

/**
 * Decides what a generated diagram should look like, as plain data.
 *
 * Kept apart from the Excalidraw conversion in ./compile deliberately. This is
 * where every judgement lives, geometry, alignment and colour, and it is all
 * ordinary objects, so it can be tested without a DOM. Importing Excalidraw
 * needs `window` at module load, which is why the colour bug this file now
 * guards against had no test before.
 */

/**
 * Emphasis colours the model can ask for by name.
 *
 * `normal` is deliberately absent: an unemphasised node keeps whatever the
 * sketch was drawn in. Baking a colour in here is what made a red diagram come
 * back black, which reads as the feature overwriting your work rather than
 * tidying it.
 */
const PALETTE = {
  accent: { stroke: "#1971c2", background: "#e7f5ff" },
  muted: { stroke: "#868e96", background: "#f1f3f5" },
  success: { stroke: "#2f9e44", background: "#ebfbee" },
  danger: { stroke: "#e03131", background: "#fff5f5" },
} as const;

/** Excalidraw's own defaults, used when a sketch says nothing about colour. */
const DEFAULT_INK: Ink = { stroke: "#1e1e1e", background: "transparent" };

/** The stroke and fill a sketch was actually drawn in. */
export interface Ink {
  stroke: string;
  background: string;
}

/**
 * The colours the user was drawing in, by simple majority.
 *
 * Majority rather than first-seen: a diagram is usually one colour with the odd
 * highlight, and the highlight should not decide the whole redraw. Deleted
 * elements are ignored because a tombstone is not part of what is on screen.
 */
export function inkOf(elements: readonly SyncElement[]): Ink {
  const strokes = new Map<string, number>();
  const backgrounds = new Map<string, number>();

  for (const el of elements) {
    if (el.isDeleted) continue;
    const stroke = typeof el.strokeColor === "string" ? el.strokeColor : null;
    const background = typeof el.backgroundColor === "string" ? el.backgroundColor : null;
    if (stroke) strokes.set(stroke, (strokes.get(stroke) ?? 0) + 1);
    if (background) backgrounds.set(background, (backgrounds.get(background) ?? 0) + 1);
  }

  const top = (counts: Map<string, number>, fallback: string) => {
    let best = fallback;
    let bestCount = 0;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  };

  return {
    stroke: top(strokes, DEFAULT_INK.stroke),
    background: top(backgrounds, DEFAULT_INK.background),
  };
}

const STROKE_STYLE = {
  solid: "solid",
  dashed: "dashed",
  dotted: "dotted",
} as const;

const NOTE_FONT_SIZE = 16;
/** Excalidraw renders text at 1.25x the font size. */
const NOTE_LINE_HEIGHT = NOTE_FONT_SIZE * 1.25;
const NOTE_GAP = 12;
/** Grey, for an annotation we placed rather than one the author positioned. */
const NOTE_INK = "#868e96";

/** How far the next stacked note has to drop to clear this one. */
function noteHeight(text: string): number {
  return text.split("\n").length * NOTE_LINE_HEIGHT + NOTE_GAP;
}

export interface CompileOptions {
  /** Existing scene, needed to recover geometry in preserve mode. */
  existing: readonly SyncElement[];
  /** Where to place a recomposed diagram, in scene coordinates. */
  origin?: { x: number; y: number };
  /**
   * Colours taken from the sketch being redrawn, so the result comes back in
   * the user's own ink. Defaults to Excalidraw's black on transparent.
   */
  ink?: Ink;
}

export interface DiagramStats {
  nodes: number;
  edges: number;
  rankCount: number;
  reversedEdges: number;
  aligned: number;
  mode: "preserve" | "layout";
}

export interface DiagramPlan {
  /** Excalidraw "skeleton" objects, ready for convertToExcalidrawElements. */
  skeletons: Record<string, unknown>[];
  /** Ids of input elements the diagram replaces; the caller tombstones these. */
  replacedIds: string[];
  stats: DiagramStats;
}

function boundsOf(elements: readonly SyncElement[]): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of elements) {
    const x = Number(el.x);
    const y = Number(el.y);
    const w = Number(el.width ?? 0);
    const h = Number(el.height ?? 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (Number.isFinite(w) ? w : 0));
    maxY = Math.max(maxY, y + (Number.isFinite(h) ? h : 0));
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function planDiagram(
  diagram: LimnDiagram,
  options: CompileOptions,
): DiagramPlan {
  const byId = new Map(options.existing.map((el) => [el.id, el]));
  const preserve = diagram.layout === "preserve";

  const geometry = new Map<string, LayoutBox>();
  /** Fill each preserved node was drawn with, so emphasis cannot repaint it. */
  const sourceBackground = new Map<string, string>();
  const replacedIds: string[] = [];
  let aligned = 0;
  let rankCount = 0;
  let reversedEdges = 0;

  if (preserve) {
    // "Same intent" means the same arrangement. Each node keeps the bounding box
    // of whatever the user actually drew for it; only sizes and alignment change.
    const boxes: Box[] = [];
    const order: string[] = [];

    for (const node of diagram.nodes) {
      const sources = node.sourceIds
        .map((id) => byId.get(id))
        .filter((el): el is SyncElement => el !== undefined);
      const bounds = boundsOf(sources);
      if (!bounds) continue;
      boxes.push(bounds);
      order.push(node.id);
      // Prefer a source that is actually filled: a node's sources include the
      // text inside it, and bound text is always transparent, so first-seen
      // would report "no fill" for a shape the user did fill.
      const filled = sources.find(
        (el) => typeof el.backgroundColor === "string" && el.backgroundColor !== "transparent",
      );
      const fill = filled?.backgroundColor ?? sources[0]?.backgroundColor;
      if (typeof fill === "string") sourceBackground.set(node.id, fill);
      replacedIds.push(...sources.map((el) => el.id));
    }

    // Tidy up: shared baselines, matching sizes, even gaps. Deterministic, and
    // it is most of what makes the result read as "designed".
    const result = alignBoxes(boxes, { grid: 4 });
    aligned = result.moved.length;
    order.forEach((id, index) => {
      const box = result.boxes[index];
      if (box) geometry.set(id, { id, ...box });
    });

    // A node the model claimed but could not ground in the sketch has nowhere to
    // go; drop it rather than guess a position.
    diagram = {
      ...diagram,
      nodes: diagram.nodes.filter((node) => geometry.has(node.id)),
    };
    const kept = new Set(diagram.nodes.map((n) => n.id));
    diagram = {
      ...diagram,
      edges: diagram.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
    };
  } else {
    const origin = options.origin ?? { x: 0, y: 0 };
    const layout = layoutDiagram(diagram.nodes, diagram.edges, {
      direction: diagram.layout === "layered-lr" ? "LR" : "TB",
      originX: origin.x,
      originY: origin.y,
    });
    rankCount = layout.rankCount;
    reversedEdges = layout.reversedEdges;
    for (const [id, box] of layout.boxes) geometry.set(id, box);
    for (const node of diagram.nodes) replacedIds.push(...node.sourceIds);
    for (const edge of diagram.edges) replacedIds.push(...edge.sourceIds);
  }

  // Skeleton ids must be unique within the scene, and the model's short ids
  // ("n1") would collide with a previous generation's.
  const stamp = Math.random().toString(36).slice(2, 8);
  const elementId = (nodeId: string) => `limn-${stamp}-${nodeId}`;

  const skeletons: Record<string, unknown>[] = [];

  const ink = options.ink ?? DEFAULT_INK;

  for (const node of diagram.nodes) {
    const box = geometry.get(node.id);
    if (!box) continue;
    // An emphasised node takes the semantic colour the model asked for; an
    // ordinary one keeps the sketch's own ink.
    const palette = PALETTE[node.emphasis as keyof typeof PALETTE];
    const colors = palette ?? ink;
    // Emphasis is a stroke, not a repaint. PALETTE's fills are Excalidraw's own
    // pale blue and red tints, so applying one in preserve mode hands back a
    // blue box over a red sketch. sourceBackground is only populated in preserve
    // mode; a recomposed diagram has no fill of the author's to keep.
    const background = palette
      ? (sourceBackground.get(node.id) ?? palette.background)
      : colors.background;
    skeletons.push({
      type: node.shape,
      id: elementId(node.id),
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      strokeColor: colors.stroke,
      backgroundColor: background,
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: 1,
      roundness: node.shape === "rectangle" ? { type: 3 } : null,
      ...(node.label ? { label: { text: node.label, fontSize: 20 } } : {}),
    });
  }

  for (const edge of diagram.edges) {
    const from = geometry.get(edge.from);
    const to = geometry.get(edge.to);
    if (!from || !to) continue;
    skeletons.push({
      type: "arrow",
      // Start and end are bound by id; Excalidraw computes the attachment points
      // and keeps them attached when either node is later moved.
      start: { id: elementId(edge.from) },
      end: { id: elementId(edge.to) },
      x: from.x + from.width / 2,
      y: from.y + from.height / 2,
      strokeColor: ink.stroke,
      strokeWidth: 2,
      strokeStyle: STROKE_STYLE[edge.style],
      roughness: 1,
      endArrowhead: edge.directed ? "arrow" : null,
      ...(edge.label ? { label: { text: edge.label, fontSize: 16 } } : {}),
    });
  }

  // Annotations carry no geometry of their own, so they stack under the diagram.
  // In preserve mode that is wrong for any note the author actually wrote: the
  // one promise the mode makes is that nothing moves, and a note collected off
  // to one side of the sketch was being marched into a column under it, in grey,
  // whatever colour it was written in. Grounded notes stay put; only a note with
  // no source left to point at falls back to the stack.
  if (diagram.notes.length > 0) {
    const all = [...geometry.values()];
    const baseX = all.length ? Math.min(...all.map((b) => b.x)) : (options.origin?.x ?? 0);
    const baseY = all.length
      ? Math.max(...all.map((b) => b.y + b.height)) + 40
      : (options.origin?.y ?? 0);
    let stacked = 0;

    for (const note of diagram.notes) {
      const sources = preserve
        ? note.sourceIds
            .map((id) => byId.get(id))
            .filter((el): el is SyncElement => el !== undefined)
        : [];
      const bounds = boundsOf(sources);
      const written = sources.find((el) => typeof el.strokeColor === "string")?.strokeColor;

      skeletons.push({
        type: "text",
        x: bounds ? bounds.x : baseX,
        y: bounds ? bounds.y : baseY + stacked,
        text: note.text,
        fontSize: NOTE_FONT_SIZE,
        strokeColor: bounds && typeof written === "string" ? written : NOTE_INK,
      });
      // Stepping by a flat 30px overlapped any note that runs to two lines.
      if (!bounds) stacked += noteHeight(note.text);
      replacedIds.push(...note.sourceIds);
    }
  }


  return {
    skeletons,
    replacedIds: [...new Set(replacedIds)],
    stats: {
      nodes: diagram.nodes.length,
      edges: diagram.edges.length,
      rankCount,
      reversedEdges,
      aligned,
      mode: preserve ? "preserve" : "layout",
    },
  };
}
