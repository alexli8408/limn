"use client";

import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { alignBoxes, type Box } from "@limn/shapes";
import type { SyncElement } from "@limn/protocol";
import { layoutDiagram, type LayoutBox } from "./layout";
import type { LimnDiagram } from "./schema";

/**
 * Turns a LimnDiagram into real Excalidraw elements.
 *
 * Everything goes through `convertToExcalidrawElements`, which takes the
 * "skeleton" form Excalidraw publishes for exactly this purpose. It is what
 * generates seeds, version nonces, fractional indices, bound text containers and
 *, critically, arrow bindings with correct focus and gap. Hand-building
 * elements to avoid the dependency means reimplementing all of that, and the
 * failure mode is arrows that look attached until the first time something moves.
 */

const PALETTE = {
  normal: { stroke: "#1e1e1e", background: "#ffffff" },
  accent: { stroke: "#1971c2", background: "#e7f5ff" },
  muted: { stroke: "#868e96", background: "#f1f3f5" },
  success: { stroke: "#2f9e44", background: "#ebfbee" },
  danger: { stroke: "#e03131", background: "#fff5f5" },
} as const;

const STROKE_STYLE = {
  solid: "solid",
  dashed: "dashed",
  dotted: "dotted",
} as const;

export interface CompileOptions {
  /** Existing scene, needed to recover geometry in preserve mode. */
  existing: readonly SyncElement[];
  /** Where to place a recomposed diagram, in scene coordinates. */
  origin?: { x: number; y: number };
}

export interface CompileResult {
  elements: SyncElement[];
  /** Ids of input elements the diagram replaces; the caller tombstones these. */
  replacedIds: string[];
  stats: {
    nodes: number;
    edges: number;
    rankCount: number;
    reversedEdges: number;
    aligned: number;
    mode: "preserve" | "layout";
  };
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

export function compileDiagram(
  diagram: LimnDiagram,
  options: CompileOptions,
): CompileResult {
  const byId = new Map(options.existing.map((el) => [el.id, el]));
  const preserve = diagram.layout === "preserve";

  const geometry = new Map<string, LayoutBox>();
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

  for (const node of diagram.nodes) {
    const box = geometry.get(node.id);
    if (!box) continue;
    const colors = PALETTE[node.emphasis] ?? PALETTE.normal;
    skeletons.push({
      type: node.shape,
      id: elementId(node.id),
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      strokeColor: colors.stroke,
      backgroundColor: colors.background,
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
      strokeColor: "#1e1e1e",
      strokeWidth: 2,
      strokeStyle: STROKE_STYLE[edge.style],
      roughness: 1,
      endArrowhead: edge.directed ? "arrow" : null,
      ...(edge.label ? { label: { text: edge.label, fontSize: 16 } } : {}),
    });
  }

  // Annotations are placed under the diagram; they have no geometry of their own.
  if (diagram.notes.length > 0) {
    const all = [...geometry.values()];
    const baseX = all.length ? Math.min(...all.map((b) => b.x)) : (options.origin?.x ?? 0);
    const baseY = all.length
      ? Math.max(...all.map((b) => b.y + b.height)) + 40
      : (options.origin?.y ?? 0);
    diagram.notes.forEach((note, index) => {
      skeletons.push({
        type: "text",
        x: baseX,
        y: baseY + index * 30,
        text: note.text,
        fontSize: 16,
        strokeColor: "#868e96",
      });
      replacedIds.push(...note.sourceIds);
    });
  }

  const elements = convertToExcalidrawElements(
    skeletons as Parameters<typeof convertToExcalidrawElements>[0],
  ) as unknown as SyncElement[];

  return {
    elements,
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

/**
 * Marks the sketched originals as deleted rather than removing them.
 *
 * Deletion has to converge across peers, and dropping an element from the array
 * does not: a peer that never saw the removal would helpfully broadcast it back.
 * A tombstone is an ordinary edit and merges like one.
 */
export function tombstone(
  elements: readonly SyncElement[],
  ids: readonly string[],
): SyncElement[] {
  if (ids.length === 0) return [...elements];
  const doomed = new Set(ids);
  const now = Date.now();
  return elements.map((el) =>
    doomed.has(el.id) && !el.isDeleted
      ? {
          ...el,
          isDeleted: true,
          version: el.version + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
          updated: now,
        }
      : el,
  );
}
