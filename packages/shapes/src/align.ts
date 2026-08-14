import type { Box } from "./vec.js";

/**
 * Deterministic tidy-up applied after recognition, and again by the AI
 * "refine" mode.
 *
 * Recognising each stroke in isolation gets you clean shapes that still sit at
 * slightly different heights and differ by a few pixels in size. What actually
 * reads as "drawn by a designer" is *agreement between* shapes: shared
 * baselines, matching sizes, even gaps. None of that needs a model — it is
 * one-dimensional clustering.
 */

export interface Cluster {
  center: number;
  indices: number[];
}

/**
 * Single-link 1-D clustering. Sorts, then cuts wherever consecutive values are
 * more than `tolerance` apart. Cluster centres are means, so an outlier drags
 * the group only in proportion to its distance.
 */
export function cluster1D(values: readonly number[], tolerance: number): Cluster[] {
  const order = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v);

  const clusters: Cluster[] = [];
  let current: { sum: number; indices: number[]; last: number } | null = null;

  for (const { v, i } of order) {
    if (current !== null && v - current.last <= tolerance) {
      current.sum += v;
      current.indices.push(i);
      current.last = v;
    } else {
      if (current) clusters.push({ center: current.sum / current.indices.length, indices: current.indices });
      current = { sum: v, indices: [i], last: v };
    }
  }
  if (current) clusters.push({ center: current.sum / current.indices.length, indices: current.indices });
  return clusters;
}

export interface AlignOptions {
  /** Values within this many px are treated as "meant to be the same". */
  tolerance?: number;
  /** Final coordinates are rounded to this lattice. Excalidraw's grid is 20. */
  grid?: number;
  /** Equalise widths/heights across shapes that are nearly the same size. */
  snapSizes?: boolean;
  /** Even out the gaps in rows and columns whose spacing is already close. */
  distribute?: boolean;
}

export interface AlignResult {
  boxes: Box[];
  /** Indices whose geometry actually moved — the caller only reflows those. */
  moved: number[];
  rows: number;
  columns: number;
}

const round = (v: number, grid: number): number =>
  grid > 0 ? Math.round(v / grid) * grid : v;

const centerX = (b: Box) => b.x + b.width / 2;
const centerY = (b: Box) => b.y + b.height / 2;

/**
 * Snaps a set of boxes into visual agreement. Pure: the input is never mutated.
 */
export function alignBoxes(input: readonly Box[], options: AlignOptions = {}): AlignResult {
  const boxes = input.map((b) => ({ ...b }));
  if (boxes.length < 2) {
    return { boxes, moved: [], rows: boxes.length, columns: boxes.length };
  }

  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  };

  // Tolerance scales with the scene: a tolerance that tidies a flowchart of
  // 40 px boxes would fuse a diagram of 400 px ones into a single column.
  const scale = median(boxes.map((b) => Math.hypot(b.width, b.height)));
  const tolerance = options.tolerance ?? Math.max(6, scale * 0.14);
  const grid = options.grid ?? 4;
  const snapSizes = options.snapSizes ?? true;
  const distribute = options.distribute ?? true;

  if (snapSizes) {
    for (const dim of ["width", "height"] as const) {
      for (const cluster of cluster1D(boxes.map((b) => b[dim]), tolerance)) {
        if (cluster.indices.length < 2) continue;
        const target = round(cluster.center, grid);
        for (const i of cluster.indices) {
          const box = boxes[i];
          if (!box) continue;
          // Resize about the centre so the shape does not appear to drift.
          const delta = target - box[dim];
          if (dim === "width") {
            box.x -= delta / 2;
            box.width = target;
          } else {
            box.y -= delta / 2;
            box.height = target;
          }
        }
      }
    }
  }

  const rowClusters = cluster1D(boxes.map(centerY), tolerance);
  for (const cluster of rowClusters) {
    if (cluster.indices.length < 2) continue;
    const target = round(cluster.center, grid);
    for (const i of cluster.indices) {
      const box = boxes[i];
      if (box) box.y = target - box.height / 2;
    }
  }

  const colClusters = cluster1D(boxes.map(centerX), tolerance);
  for (const cluster of colClusters) {
    if (cluster.indices.length < 2) continue;
    const target = round(cluster.center, grid);
    for (const i of cluster.indices) {
      const box = boxes[i];
      if (box) box.x = target - box.width / 2;
    }
  }

  if (distribute) {
    distributeAlong(boxes, rowClusters, "x");
    distributeAlong(boxes, colClusters, "y");
  }

  for (const box of boxes) {
    box.x = round(box.x, grid);
    box.y = round(box.y, grid);
  }

  const moved: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const before = input[i];
    const after = boxes[i];
    if (!before || !after) continue;
    if (
      Math.abs(before.x - after.x) > 0.5 ||
      Math.abs(before.y - after.y) > 0.5 ||
      Math.abs(before.width - after.width) > 0.5 ||
      Math.abs(before.height - after.height) > 0.5
    ) {
      moved.push(i);
    }
  }

  return {
    boxes,
    moved,
    rows: rowClusters.filter((c) => c.indices.length > 1).length,
    columns: colClusters.filter((c) => c.indices.length > 1).length,
  };
}

/**
 * Equalises the gaps within one row or column — but only when they are already
 * close to even. Forcing uniform spacing on a deliberately clustered layout
 * destroys grouping the user meant to express.
 */
function distributeAlong(
  boxes: Box[],
  clusters: readonly Cluster[],
  axis: "x" | "y",
): void {
  const sizeKey = axis === "x" ? "width" : "height";

  for (const cluster of clusters) {
    if (cluster.indices.length < 3) continue;
    const members = cluster.indices
      .map((i) => ({ i, box: boxes[i] }))
      .filter((m): m is { i: number; box: Box } => Boolean(m.box))
      .sort((a, b) => a.box[axis] - b.box[axis]);

    const gaps: number[] = [];
    for (let k = 1; k < members.length; k++) {
      const prev = members[k - 1];
      const cur = members[k];
      if (!prev || !cur) continue;
      gaps.push(cur.box[axis] - (prev.box[axis] + prev.box[sizeKey]));
    }
    if (gaps.length === 0) continue;

    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean <= 0) continue;
    const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
    if (Math.sqrt(variance) / mean > 0.35) continue;

    let cursor = (members[0]?.box[axis] ?? 0) + (members[0]?.box[sizeKey] ?? 0);
    for (let k = 1; k < members.length; k++) {
      const m = members[k];
      if (!m) continue;
      m.box[axis] = cursor + mean;
      cursor = m.box[axis] + m.box[sizeKey];
    }
  }
}
