import { clampIndexSafe } from "./internal.js";
import {
  dist,
  dot,
  pointSegmentDistance,
  sub,
  unit,
  type Point,
} from "./vec.js";

/** Soft membership: 1.0 at the target, falling off over `sigma`. */
export const gauss = (x: number, mu: number, sigma: number): number =>
  Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Weighted geometric mean of soft scores, a "soft AND".
 *
 * The obvious combinator is a plain product, but products collapse: five
 * factors each at a perfectly respectable 0.85 multiply out to 0.44, so every
 * shape falls below any sensible threshold and the recogniser refuses to fire.
 * Taking the weighted geometric mean keeps the result on the same scale as its
 * inputs while still letting one bad factor veto the match.
 */
export function combine(...factors: readonly (readonly [number, number])[]): number {
  let weightSum = 0;
  let acc = 0;
  for (const [score, weight] of factors) {
    acc += weight * Math.log(Math.max(score, 1e-6));
    weightSum += weight;
  }
  return weightSum <= 0 ? 0 : Math.exp(acc / weightSum);
}

/** Interior angle at each vertex of a closed polygon, in radians. */
export function interiorAngles(poly: readonly Point[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[clampIndexSafe(i - 1, n)];
    const cur = poly[i];
    const next = poly[clampIndexSafe(i + 1, n)];
    if (!prev || !cur || !next) continue;
    const v1 = unit(sub(prev, cur));
    const v2 = unit(sub(next, cur));
    out.push(Math.acos(Math.max(-1, Math.min(1, dot(v1, v2)))));
  }
  return out;
}

/**
 * Mean distance from the stroke samples to the polygon through its detected
 * corners, normalised by the shape's diagonal.
 *
 * This is what separates a hexagon from an ellipse. Both simplify to six or
 * eight corners, and both are convex and closed; the difference is that an
 * ellipse's samples bow away from every chord, while a polygon's sit on them.
 */
export function polygonDeviation(
  samples: readonly Point[],
  corners: readonly Point[],
  diagonal: number,
): number {
  if (corners.length < 3 || diagonal <= 0) return 1;
  let total = 0;
  for (const p of samples) {
    let best = Infinity;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      if (!a || !b) continue;
      const d = pointSegmentDistance(p, a, b);
      if (d < best) best = d;
    }
    total += best;
  }
  return total / samples.length / diagonal;
}

/**
 * Cleans up the raw RDP vertex list before it is used for classification.
 *
 * RDP is a distance criterion, so a hand tremor part-way along an edge can
 * exceed epsilon and register as a "corner". A rectangle then reports five
 * vertices, fails the quadrilateral tests, and falls through to the generic
 * polygon bucket, which was the single largest error source in the benchmark.
 *
 * Two passes fix it: fuse vertices that are too close together to be distinct
 * corners, then repeatedly drop the straightest remaining vertex while it is
 * still essentially collinear with its neighbours. Removing a vertex changes
 * the angles at both neighbours, so this has to iterate rather than filter once.
 */
export function refineCorners(
  corners: readonly Point[],
  diagonal: number,
  // 150° sits above a regular decagon's 144° interior angle, so genuine convex
  // polygons survive intact while tremor artefacts (≳165°) are absorbed.
  straightLimit = (150 * Math.PI) / 180,
): Point[] {
  if (corners.length < 4 || diagonal <= 0) return [...corners];

  const mergeDist = diagonal * 0.085;
  const merged: Point[] = [];
  for (const p of corners) {
    const last = merged[merged.length - 1];
    if (last && dist(last, p) < mergeDist) {
      // Average rather than discard, so fusing does not shift the vertex.
      merged[merged.length - 1] = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2];
      continue;
    }
    merged.push(p);
  }
  const head = merged[0];
  const tail = merged[merged.length - 1];
  if (merged.length > 3 && head && tail && dist(head, tail) < mergeDist) merged.pop();

  let pts = merged;
  while (pts.length > 3) {
    const angles = interiorAngles(pts);
    let idx = -1;
    let straightest = 0;
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i] ?? 0;
      if (a > straightest) {
        straightest = a;
        idx = i;
      }
    }
    if (idx < 0 || straightest <= straightLimit) break;
    pts = pts.filter((_, i) => i !== idx);
  }
  return pts;
}

/** Mean distance from each corner to its closest target, over the diagonal. */
export function corresponds(
  corners: readonly Point[],
  targets: readonly Point[],
  diagonal: number,
): number {
  if (corners.length === 0 || targets.length === 0 || diagonal <= 0) return 1;
  let total = 0;
  for (const c of corners) {
    let best = Infinity;
    for (const t of targets) best = Math.min(best, dist(c, t));
    total += best;
  }
  return total / corners.length / diagonal;
}

export interface QuadDiagonals {
  /** The two diagonals as (from, to) pairs. */
  d1: readonly [Point, Point];
  d2: readonly [Point, Point];
  /** |cos| between the diagonals. 0 for a rhombus/diamond. */
  skew: number;
  /** How far the diagonal midpoints sit apart, over the diagonal. 0 if they bisect. */
  offset: number;
  center: Point;
  lengths: readonly [number, number];
}

/**
 * Diamond test, expressed in a rotation-invariant way.
 *
 * A diamond is a quadrilateral whose diagonals are perpendicular and bisect
 * each other. Testing that directly, rather than checking whether corners land
 * on the midpoints of some axis-aligned box, means a diamond drawn at 30°
 * classifies exactly as well as one drawn flat.
 */
export function quadDiagonals(quad: readonly Point[], diagonal: number): QuadDiagonals | null {
  const [a, b, c, d] = quad;
  if (!a || !b || !c || !d) return null;

  const v1 = sub(c, a);
  const v2 = sub(d, b);
  const l1 = Math.hypot(v1[0], v1[1]);
  const l2 = Math.hypot(v2[0], v2[1]);
  if (l1 < 1e-6 || l2 < 1e-6) return null;

  const m1: Point = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  const m2: Point = [(b[0] + d[0]) / 2, (b[1] + d[1]) / 2];

  return {
    d1: [a, c],
    d2: [b, d],
    skew: Math.abs(dot(v1, v2)) / (l1 * l2),
    offset: diagonal > 0 ? dist(m1, m2) / diagonal : 1,
    center: [(m1[0] + m2[0]) / 2, (m1[1] + m2[1]) / 2],
    lengths: [l1, l2],
  };
}
