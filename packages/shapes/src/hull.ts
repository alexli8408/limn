import { cross, dist, sub, unit, type Point } from "./vec.js";

/** Andrew's monotone chain. O(n log n), counter-clockwise, no duplicate endpoint. */
export function convexHull(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const build = (src: readonly Point[]): Point[] => {
    const chain: Point[] = [];
    for (const p of src) {
      while (chain.length >= 2) {
        const a = chain[chain.length - 2];
        const b = chain[chain.length - 1];
        if (!a || !b || cross(sub(b, a), sub(p, a)) > 0) break;
        chain.pop();
      }
      chain.push(p);
    }
    chain.pop();
    return chain;
  };

  return [...build(sorted), ...build([...sorted].reverse())];
}

export interface OrientedRect {
  /** Centre, not corner, the corner depends on rotation. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Radians. `width` runs along this direction. */
  angle: number;
  area: number;
}

/**
 * Minimum-area enclosing rectangle via rotating calipers.
 *
 * The minimal rectangle is always flush with a hull edge, so it suffices to
 * test one orientation per edge. Hulls here are tiny (a simplified stroke
 * yields well under 50 vertices), which makes the naive O(h²) projection
 * cheaper in practice than maintaining caliper state.
 */
export function minAreaRect(points: readonly Point[]): OrientedRect {
  const hull = convexHull(points);
  if (hull.length < 3) {
    const a = hull[0] ?? ([0, 0] as Point);
    const b = hull[1] ?? a;
    const d = sub(b, a);
    return {
      cx: (a[0] + b[0]) / 2,
      cy: (a[1] + b[1]) / 2,
      width: dist(a, b),
      height: 0,
      angle: Math.atan2(d[1], d[0]),
      area: 0,
    };
  }

  let best: OrientedRect | null = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if (!a || !b) continue;
    const edge = unit(sub(b, a));
    if (edge[0] === 0 && edge[1] === 0) continue;
    const normal: Point = [-edge[1], edge[0]];

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * edge[0] + p[1] * edge[1];
      const v = p[0] * normal[0] + p[1] * normal[1];
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const width = maxU - minU;
    const height = maxV - minV;
    const area = width * height;
    if (best === null || area < best.area) {
      const midU = (minU + maxU) / 2;
      const midV = (minV + maxV) / 2;
      best = {
        cx: edge[0] * midU + normal[0] * midV,
        cy: edge[1] * midU + normal[1] * midV,
        width,
        height,
        angle: Math.atan2(edge[1], edge[0]),
        area,
      };
    }
  }

  return best ?? { cx: 0, cy: 0, width: 0, height: 0, angle: 0, area: 0 };
}

/**
 * Folds an oriented rect into the [-45°, 45°) band. A rectangle drawn at 91°
 * is the same rectangle as one at 1° with its sides swapped, and downstream
 * "is this near axis-aligned?" checks need one canonical representative.
 */
export function normalizeRect(rect: OrientedRect): OrientedRect {
  let { width, height, angle } = rect;
  const quarter = Math.PI / 2;
  angle = ((angle % Math.PI) + Math.PI) % Math.PI;
  if (angle >= quarter) {
    angle -= quarter;
    [width, height] = [height, width];
  }
  if (angle > Math.PI / 4) {
    angle -= quarter;
    [width, height] = [height, width];
  }
  return { ...rect, width, height, angle };
}

/** Corner points of an oriented rect, clockwise from the (-u,-v) corner. */
export function rectCorners(rect: OrientedRect): Point[] {
  const c = Math.cos(rect.angle);
  const s = Math.sin(rect.angle);
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const offsets: Point[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return offsets.map(([ox, oy]) => [
    rect.cx + ox * c - oy * s,
    rect.cy + ox * s + oy * c,
  ]);
}
