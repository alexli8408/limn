import { centroid, dist, type Point } from "./vec.js";

/**
 * Closed-form eigendecomposition of the symmetric 2×2 matrix [[a, b], [b, d]].
 * Returns eigenvalues descending, with the corresponding unit eigenvectors.
 */
function eigenSym2(a: number, b: number, d: number): {
  l1: number;
  l2: number;
  v1: Point;
  v2: Point;
} {
  const tr = a + d;
  const det = a * d - b * b;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;

  let v1: Point;
  if (Math.abs(b) > 1e-12) {
    const vx = l1 - d;
    const vy = b;
    const n = Math.hypot(vx, vy) || 1;
    v1 = [vx / n, vy / n];
  } else {
    v1 = a >= d ? [1, 0] : [0, 1];
  }
  return { l1, l2, v1, v2: [-v1[1], v1[0]] };
}

export interface LineFit {
  /** A point on the line, and a unit direction. */
  origin: Point;
  direction: Point;
  /** Mean perpendicular distance from the samples, in source units. */
  residual: number;
  start: Point;
  end: Point;
}

/**
 * Total-least-squares line fit.
 *
 * Ordinary least squares minimises vertical error, which makes it useless
 * here, it degenerates completely on a vertical stroke, and a vertical stroke
 * is exactly what someone drawing a flowchart edge produces.
 */
export function fitLine(points: readonly Point[]): LineFit {
  const c = centroid(points);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const n = Math.max(points.length, 1);
  const { v1 } = eigenSym2(sxx / n, sxy / n, syy / n);

  let residual = 0;
  let minT = Infinity;
  let maxT = -Infinity;
  for (const p of points) {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    const t = dx * v1[0] + dy * v1[1];
    const perp = Math.abs(dx * -v1[1] + dy * v1[0]);
    residual += perp;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }

  return {
    origin: c,
    direction: v1,
    residual: residual / n,
    start: [c[0] + v1[0] * minT, c[1] + v1[1] * minT],
    end: [c[0] + v1[0] * maxT, c[1] + v1[1] * maxT],
  };
}

export interface CircleFit {
  cx: number;
  cy: number;
  r: number;
  /** Mean |‖p − c‖ − r|, in source units. */
  residual: number;
}

/**
 * Kåsa algebraic circle fit: minimising (x² + y² + Dx + Ey + F)² makes the
 * problem linear, which keeps this at a handful of microseconds. The known
 * bias toward small radii on short arcs is irrelevant, a stroke that only
 * covers a short arc will not be classified as a closed shape anyway.
 */
export function fitCircle(points: readonly Point[]): CircleFit {
  const n = points.length;
  if (n < 3) return { cx: 0, cy: 0, r: 0, residual: Infinity };

  const c = centroid(points);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (const p of points) {
    const x = p[0] - c[0];
    const y = p[1] - c[1];
    const z = x * x + y * y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
  }

  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9) return { cx: c[0], cy: c[1], r: 0, residual: Infinity };

  const ux = (sxz * syy - syz * sxy) / (2 * det);
  const uy = (syz * sxx - sxz * sxy) / (2 * det);
  const cx = c[0] + ux;
  const cy = c[1] + uy;

  let r = 0;
  for (const p of points) r += dist(p, [cx, cy]);
  r /= n;

  let residual = 0;
  for (const p of points) residual += Math.abs(dist(p, [cx, cy]) - r);

  return { cx, cy, r, residual: residual / n };
}

export interface EllipseFit {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Radians; `rx` runs along this direction. */
  angle: number;
  /** Mean |‖(u/rx, v/ry)‖ − 1|, dimensionless, so it compares across scales. */
  residual: number;
}

/**
 * Orientation from the second moments, radii from the extents along those axes.
 *
 * The textbook approach (Fitzgibbon's direct conic fit) needs a generalised
 * eigensolver for a 6×6 system. Splitting the problem is far cheaper and, for
 * a stroke that samples the whole boundary roughly uniformly, just as accurate:
 * PCA recovers the axes exactly, and the extents along them *are* the radii.
 */
export function fitEllipse(points: readonly Point[]): EllipseFit {
  const c = centroid(points);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const n = Math.max(points.length, 1);
  const { v1, v2 } = eigenSym2(sxx / n, sxy / n, syy / n);

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of points) {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    const u = dx * v1[0] + dy * v1[1];
    const v = dx * v2[0] + dy * v2[1];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const rx = Math.max((maxU - minU) / 2, 1e-6);
  const ry = Math.max((maxV - minV) / 2, 1e-6);
  const midU = (minU + maxU) / 2;
  const midV = (minV + maxV) / 2;
  const cx = c[0] + v1[0] * midU + v2[0] * midV;
  const cy = c[1] + v1[1] * midU + v2[1] * midV;

  let residual = 0;
  for (const p of points) {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const u = (dx * v1[0] + dy * v1[1]) / rx;
    const v = (dx * v2[0] + dy * v2[1]) / ry;
    residual += Math.abs(Math.hypot(u, v) - 1);
  }

  return { cx, cy, rx, ry, angle: Math.atan2(v1[1], v1[0]), residual: residual / n };
}
