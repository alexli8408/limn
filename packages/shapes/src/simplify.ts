import { dist, pathLength, pointLineDistance, type Point } from "./vec.js";

/**
 * Ramer–Douglas–Peucker, iterative.
 *
 * The recursive formulation blows the stack on the strokes that matter most:
 * a slow deliberate line from a stylus at 240 Hz is tens of thousands of
 * points, and the worst case recurses once per point.
 */
export function rdp(points: readonly Point[], epsilon: number): Point[] {
  const n = points.length;
  if (n < 3) return [...points];

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) break;
    const [start, end] = range;
    if (end - start < 2) continue;

    const a = points[start];
    const b = points[end];
    if (!a || !b) continue;

    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      if (!p) continue;
      const d = pointLineDistance(p, a, b);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > epsilon && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (keep[i] && p) out.push(p);
  }
  return out;
}

/**
 * Arc-length resampling to exactly `count` points. Recognition metrics compare
 * strokes drawn at wildly different speeds — a fast flick and a slow trace of
 * the same circle carry very different point densities — and every angular
 * measure is meaningless until that is normalised away.
 */
export function resample(points: readonly Point[], count: number): Point[] {
  if (points.length < 2 || count < 2) return [...points];
  const total = pathLength(points);
  if (total < 1e-9) {
    const first = points[0];
    return first ? new Array(count).fill(first) : [];
  }

  const step = total / (count - 1);
  const first = points[0];
  if (!first) return [];

  const out: Point[] = [first];
  let segIdx = 1;
  let carried = 0;
  let cursor: Point = first;

  while (out.length < count && segIdx < points.length) {
    const next = points[segIdx];
    if (!next) break;
    const segLen = dist(cursor, next);

    if (carried + segLen >= step) {
      const t = (step - carried) / segLen;
      const p: Point = [
        cursor[0] + (next[0] - cursor[0]) * t,
        cursor[1] + (next[1] - cursor[1]) * t,
      ];
      out.push(p);
      cursor = p;
      carried = 0;
    } else {
      carried += segLen;
      cursor = next;
      segIdx++;
    }
  }

  // Float drift can leave us a point short of `count`.
  const last = points[points.length - 1];
  while (out.length < count && last) out.push(last);
  return out;
}

/**
 * Chaikin corner cutting. Two iterations turn the polygonal jitter of a hand
 * drawn stroke into something that reads as a deliberate curve, without the
 * overshoot a spline fit produces at sharp reversals.
 */
export function chaikin(points: readonly Point[], iterations = 2, closed = false): Point[] {
  let current: Point[] = [...points];
  for (let iter = 0; iter < iterations; iter++) {
    if (current.length < 3) break;
    const next: Point[] = [];
    if (!closed) {
      const first = current[0];
      if (first) next.push(first);
    }
    const limit = closed ? current.length : current.length - 1;
    for (let i = 0; i < limit; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      if (!a || !b) continue;
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) {
      const last = current[current.length - 1];
      if (last) next.push(last);
    }
    current = next;
  }
  return current;
}

/**
 * Gaussian smoothing along the parameter, with endpoints clamped so a
 * smoothed stroke still starts and ends exactly where the user lifted the pen.
 */
export function smoothGaussian(points: readonly Point[], sigma = 1.4): Point[] {
  if (points.length < 3 || sigma <= 0) return [...points];
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = (kernel[i] ?? 0) / sum;

  const n = points.length;
  const out: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i === 0 || i === n - 1) {
      out[i] = points[i] as Point;
      continue;
    }
    let x = 0;
    let y = 0;
    for (let k = -radius; k <= radius; k++) {
      const idx = Math.min(n - 1, Math.max(0, i + k));
      const p = points[idx];
      const w = kernel[k + radius] ?? 0;
      if (p) {
        x += p[0] * w;
        y += p[1] * w;
      }
    }
    out[i] = [x, y];
  }
  return out;
}
