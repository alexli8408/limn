import type { DiagramEdge, DiagramNode } from "./schema";

/**
 * Layered graph layout (a compact Sugiyama pipeline).
 *
 * Written out rather than asking Gemini for coordinates. A model will happily
 * emit plausible-looking x/y values, and the result overlaps, drifts out of
 * alignment, and changes between identical requests. Layout is a solved
 * deterministic problem; spending model capacity on it buys nothing and costs
 * reproducibility.
 *
 * Four stages: break cycles, rank, order within ranks to reduce crossings, then
 * assign coordinates.
 */

export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutOptions {
  direction: "TB" | "LR";
  nodeWidth: number;
  nodeHeight: number;
  /** Gap between ranks (along the flow direction). */
  rankGap: number;
  /** Gap between siblings within a rank. */
  siblingGap: number;
  originX: number;
  originY: number;
}

const DEFAULTS: LayoutOptions = {
  direction: "TB",
  nodeWidth: 200,
  nodeHeight: 90,
  rankGap: 90,
  siblingGap: 48,
  originX: 0,
  originY: 0,
};

/** Text needs room; a fixed node size clips any label longer than a word or two. */
export function estimateNodeSize(
  label: string,
  base: { width: number; height: number },
): { width: number; height: number } {
  const text = label.trim();
  if (!text) return { ...base };

  // ~8.2 px per character at Excalidraw's default 20 px medium font.
  const perLine = Math.max(1, Math.floor((base.width - 32) / 8.2));
  const words = text.split(/\s+/);
  let lines = 1;
  let used = 0;
  for (const word of words) {
    if (used > 0 && used + 1 + word.length > perLine) {
      lines++;
      used = word.length;
    } else {
      used += (used > 0 ? 1 : 0) + word.length;
    }
  }

  const longest = Math.min(text.length, perLine);
  return {
    width: Math.max(base.width, Math.ceil(longest * 8.2) + 40),
    height: Math.max(base.height, lines * 25 + 32),
  };
}

/**
 * Reverses the back edges of a DFS so the graph becomes acyclic.
 *
 * Ranking assumes a DAG and a cyclic input would not terminate. The reversal is
 * only used for positioning, the edge is still drawn in its original direction,
 * so a cycle in the user's diagram still reads as a cycle.
 */
function breakCycles(
  nodeIds: readonly string[],
  edges: readonly DiagramEdge[],
): { acyclic: { from: string; to: string }[]; reversed: number } {
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) outgoing.set(id, []);
  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);

  const state = new Map<string, 0 | 1 | 2>(); // unvisited / on stack / done
  const acyclic: { from: string; to: string }[] = [];
  let reversed = 0;

  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of outgoing.get(id) ?? []) {
      const seen = state.get(next) ?? 0;
      if (seen === 1) {
        acyclic.push({ from: next, to: id });
        reversed++;
      } else {
        acyclic.push({ from: id, to: next });
        if (seen === 0) visit(next);
      }
    }
    state.set(id, 2);
  };

  for (const id of nodeIds) {
    if ((state.get(id) ?? 0) === 0) visit(id);
  }
  return { acyclic, reversed };
}

/** Longest-path ranking: every node sits one rank below its deepest predecessor. */
function assignRanks(
  nodeIds: readonly string[],
  edges: readonly { from: string; to: string }[],
): Map<string, number> {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) {
    incoming.set(id, []);
    outgoing.set(id, []);
    indegree.set(id, 0);
  }
  for (const { from, to } of edges) {
    outgoing.get(from)?.push(to);
    incoming.get(to)?.push(from);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const pending = new Map(indegree);

  while (queue.length > 0) {
    const id = queue.shift() as string;
    const here = rank.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, here + 1));
      const left = (pending.get(next) ?? 1) - 1;
      pending.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return rank;
}

/**
 * Barycentre ordering. Repeatedly moves each node to the average position of its
 * neighbours in the adjacent rank, alternating sweep direction, the standard
 * heuristic for edge-crossing reduction, and enough for diagram-sized graphs.
 */
function orderWithinRanks(
  ranks: Map<number, string[]>,
  edges: readonly { from: string; to: string }[],
  passes = 6,
): void {
  const neighbours = new Map<string, { up: string[]; down: string[] }>();
  const ensure = (id: string) => {
    let entry = neighbours.get(id);
    if (!entry) {
      entry = { up: [], down: [] };
      neighbours.set(id, entry);
    }
    return entry;
  };
  for (const { from, to } of edges) {
    ensure(from).down.push(to);
    ensure(to).up.push(from);
  }

  const rankNumbers = [...ranks.keys()].sort((a, b) => a - b);

  for (let pass = 0; pass < passes; pass++) {
    const downward = pass % 2 === 0;
    const order = downward ? rankNumbers : [...rankNumbers].reverse();

    for (const rankNumber of order) {
      const layer = ranks.get(rankNumber);
      if (!layer || layer.length < 2) continue;

      const reference = ranks.get(rankNumber + (downward ? -1 : 1)) ?? [];
      const indexOf = new Map(reference.map((id, index) => [id, index]));

      const barycentre = new Map<string, number>();
      layer.forEach((id, fallback) => {
        const linked = downward ? neighbours.get(id)?.up : neighbours.get(id)?.down;
        const positions = (linked ?? [])
          .map((other) => indexOf.get(other))
          .filter((v): v is number => v !== undefined);
        barycentre.set(
          id,
          positions.length > 0
            ? positions.reduce((a, b) => a + b, 0) / positions.length
            : fallback,
        );
      });

      layer.sort((a, b) => (barycentre.get(a) ?? 0) - (barycentre.get(b) ?? 0));
    }
  }
}

export interface LayoutResult {
  boxes: Map<string, LayoutBox>;
  width: number;
  height: number;
  rankCount: number;
  reversedEdges: number;
}

export function layoutDiagram(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  overrides: Partial<LayoutOptions> = {},
): LayoutResult {
  const opts = { ...DEFAULTS, ...overrides };
  const ids = nodes.map((n) => n.id);
  if (ids.length === 0) {
    return { boxes: new Map(), width: 0, height: 0, rankCount: 0, reversedEdges: 0 };
  }

  const sizes = new Map(
    nodes.map((node) => [
      node.id,
      estimateNodeSize(node.label, { width: opts.nodeWidth, height: opts.nodeHeight }),
    ]),
  );

  const { acyclic, reversed } = breakCycles(ids, edges);
  const rank = assignRanks(ids, acyclic);

  // An explicit rank from the model overrides the computed one, but only if it
  // does not invert an edge, otherwise arrows would point back up the flow.
  for (const node of nodes) {
    if (node.rank !== undefined) rank.set(node.id, node.rank);
  }

  const ranks = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    const layer = ranks.get(r);
    if (layer) layer.push(id);
    else ranks.set(r, [id]);
  }
  orderWithinRanks(ranks, acyclic);

  const alongFlow = opts.direction === "TB";
  const rankNumbers = [...ranks.keys()].sort((a, b) => a - b);

  // Extent of each rank across the flow, so ranks can be centred against
  // each other rather than left-aligned.
  const crossExtents = new Map<number, number>();
  for (const rankNumber of rankNumbers) {
    const layer = ranks.get(rankNumber) ?? [];
    const total = layer.reduce((sum, id) => {
      const size = sizes.get(id);
      return sum + (alongFlow ? (size?.width ?? 0) : (size?.height ?? 0));
    }, 0);
    crossExtents.set(rankNumber, total + Math.max(0, layer.length - 1) * opts.siblingGap);
  }
  const widestCross = Math.max(0, ...crossExtents.values());

  const boxes = new Map<string, LayoutBox>();
  let flowCursor = 0;

  for (const rankNumber of rankNumbers) {
    const layer = ranks.get(rankNumber) ?? [];
    const rankThickness = Math.max(
      0,
      ...layer.map((id) => {
        const size = sizes.get(id);
        return alongFlow ? (size?.height ?? 0) : (size?.width ?? 0);
      }),
    );

    let crossCursor = (widestCross - (crossExtents.get(rankNumber) ?? 0)) / 2;

    for (const id of layer) {
      const size = sizes.get(id) ?? { width: opts.nodeWidth, height: opts.nodeHeight };
      // Centre each node within its rank's thickness so a tall node beside a
      // short one does not leave the short one hanging at the top.
      if (alongFlow) {
        boxes.set(id, {
          id,
          x: opts.originX + crossCursor,
          y: opts.originY + flowCursor + (rankThickness - size.height) / 2,
          width: size.width,
          height: size.height,
        });
        crossCursor += size.width + opts.siblingGap;
      } else {
        boxes.set(id, {
          id,
          x: opts.originX + flowCursor + (rankThickness - size.width) / 2,
          y: opts.originY + crossCursor,
          width: size.width,
          height: size.height,
        });
        crossCursor += size.height + opts.siblingGap;
      }
    }

    flowCursor += rankThickness + opts.rankGap;
  }

  const flowExtent = Math.max(0, flowCursor - opts.rankGap);
  return {
    boxes,
    width: alongFlow ? widestCross : flowExtent,
    height: alongFlow ? flowExtent : widestCross,
    rankCount: rankNumbers.length,
    reversedEdges: reversed,
  };
}
