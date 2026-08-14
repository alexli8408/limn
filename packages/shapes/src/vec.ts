/** Excalidraw stores stroke points as `[x, y]` tuples; we match that layout so
 *  recognition can run directly on element data with no marshalling. */
export type Point = readonly [number, number];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Point, k: number): Point => [a[0] * k, a[1] * k];
export const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0];
export const norm = (a: Point): number => Math.hypot(a[0], a[1]);
export const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function unit(a: Point): Point {
  const n = norm(a);
  return n < 1e-9 ? [0, 0] : [a[0] / n, a[1] / n];
}

export function rotate(p: Point, angle: number, about: Point = [0, 0]): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p[0] - about[0];
  const dy = p[1] - about[1];
  return [about[0] + dx * c - dy * s, about[1] + dx * s + dy * c];
}

export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += dist(a, b);
  }
  return total;
}

export function bbox(points: readonly Point[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function centroid(points: readonly Point[]): Point {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p[0];
    sy += p[1];
  }
  const n = Math.max(points.length, 1);
  return [sx / n, sy / n];
}

/** Signed shoelace area. Sign encodes winding, which callers occasionally need. */
export function signedArea(points: readonly Point[]): number {
  let area = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a && b) area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

export const polygonArea = (points: readonly Point[]): number => Math.abs(signedArea(points));

export function perimeter(points: readonly Point[]): number {
  if (points.length < 2) return 0;
  const first = points[0];
  const last = points[points.length - 1];
  let p = pathLength(points);
  if (first && last) p += dist(last, first);
  return p;
}

/** Perpendicular distance from `p` to the infinite line through `a` and `b`. */
export function pointLineDistance(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const len = norm(ab);
  if (len < 1e-9) return dist(p, a);
  return Math.abs(cross(ab, sub(p, a))) / len;
}

/** Distance from `p` to the finite segment `a`–`b` (clamped, unlike the line form). */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const lenSq = dot(ab, ab);
  if (lenSq < 1e-12) return dist(p, a);
  let t = dot(sub(p, a), ab) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
}

/** Interior turn angle at `b`, in radians. 0 = straight through, π = full reversal. */
export function turnAngle(a: Point, b: Point, c: Point): number {
  const v1 = unit(sub(b, a));
  const v2 = unit(sub(c, b));
  const d = Math.max(-1, Math.min(1, dot(v1, v2)));
  return Math.acos(d);
}

/** Collapses points closer together than `epsilon`; sub-pixel jitter otherwise
 *  dominates every downstream angle computation. */
export function dedupe(points: readonly Point[], epsilon = 0.5): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > epsilon) out.push(p);
  }
  if (out.length === 1 && points.length > 1) {
    const last = points[points.length - 1];
    if (last) out.push(last);
  }
  return out;
}
