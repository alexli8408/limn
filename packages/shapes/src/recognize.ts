import { fitEllipse, fitLine } from "./fit.js";
import { convexHull, minAreaRect, normalizeRect, rectCorners } from "./hull.js";
import {
  clamp01,
  combine,
  corresponds,
  gauss,
  interiorAngles,
  mean,
  polygonDeviation,
  quadDiagonals,
  refineCorners,
} from "./score.js";
import { chaikin, rdp, resample, smoothGaussian } from "./simplify.js";
import {
  bbox,
  centroid,
  dist,
  dot,
  pathLength,
  perimeter,
  polygonArea,
  sub,
  turnAngle,
  unit,
  dedupe,
  type Box,
  type Point,
} from "./vec.js";

export type ShapeKind =
  | "line"
  | "arrow"
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "polygon"
  | "freedraw";

export interface RecognitionMetrics {
  pointCount: number;
  pathLength: number;
  diagonal: number;
  /** ‖end − start‖ / pathLength. ~0 for a closed loop, ~1 for a straight line. */
  gapRatio: number;
  closed: boolean;
  corners: number;
  /** 4πA/P². 1.0 for a circle, π/4 for a square, ~0.60 for an equilateral triangle. */
  circularity: number;
  /** Area over min-area-rect area. Note a diamond scores ~0.75, not 0.5 — its
   *  minimal enclosing rectangle is edge-aligned, not axis-aligned. */
  rectFill: number;
  convexity: number;
  lineResidual: number;
  ellipseResidual: number;
  /** Mean sample distance to the corner polygon, over the diagonal. */
  polyDeviation: number;
  /** Mean cosine between the two diagonals of a quad. 0 ⇒ diamond. */
  quadSkew: number;
  /** Mean closeness of the interior angles to 90°. 1 ⇒ rectangle. */
  rightness: number;
}

export interface Recognition {
  kind: ShapeKind;
  confidence: number;
  runnerUp: ShapeKind | null;
  scores: Partial<Record<ShapeKind, number>>;
  /** Axis-aligned box in the element's own (unrotated) frame. */
  box: Box;
  /** Radians. Excalidraw rotates about the box centre. */
  angle: number;
  /** Element-local vertices for path kinds (line, arrow, triangle, polygon). */
  points?: Point[];
  /** Prettified original, supplied when nothing was recognised. */
  smoothed?: Point[];
  metrics: RecognitionMetrics;
}

export interface RecognizeOptions {
  /** Below this, the stroke is left as the user drew it. */
  threshold?: number;
  /** Shapes within this many radians of an axis are snapped flush to it. */
  angleSnap?: number;
  /** Strokes shorter than this are treated as deliberate marks, not shapes. */
  minLength?: number;
  /** Overrides open/closed inference — the caller sometimes knows better. */
  hint?: "open" | "closed";
}

const DEFAULTS = {
  threshold: 0.55,
  angleSnap: (8 * Math.PI) / 180,
  minLength: 24,
} satisfies Required<Omit<RecognizeOptions, "hint">>;

/** Snaps to the nearest multiple of π/4 when already within `tolerance`. */
function snapAngle(angle: number, tolerance: number): number {
  const step = Math.PI / 4;
  const nearest = Math.round(angle / step) * step;
  return Math.abs(angle - nearest) <= tolerance ? nearest : angle;
}

/**
 * Rotates a closed sample sequence to begin at the point farthest from the
 * centroid, then simplifies.
 *
 * Without the rotation, RDP pins the arbitrary start/end of the stroke as two
 * "corners" that happen to sit next to each other on the loop, and a clean
 * rectangle reports five corners instead of four. Starting at an extremum puts
 * the seam on a real vertex, where it costs nothing.
 */
function closedCorners(samples: readonly Point[], epsilon: number): Point[] {
  const c = centroid(samples);
  let farIdx = 0;
  let farDist = -1;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    if (!p) continue;
    const d = dist(p, c);
    if (d > farDist) {
      farDist = d;
      farIdx = i;
    }
  }
  const rotated = [...samples.slice(farIdx), ...samples.slice(0, farIdx)];
  const first = rotated[0];
  if (first) rotated.push(first);
  const simplified = rdp(rotated, epsilon);
  if (simplified.length > 1) simplified.pop();
  return simplified;
}

interface ArrowheadResult {
  isArrow: boolean;
  tip: Point;
  tail: Point;
}

/**
 * Detects a single-stroke arrow: a straight shaft, then a fold back on itself
 * to draw the barbs. Nobody lifts the pen to draw an arrowhead.
 */
function detectArrowhead(points: readonly Point[], pathLen: number): ArrowheadResult {
  const fallbackTail = points[0] ?? ([0, 0] as Point);
  const fallbackTip = points[points.length - 1] ?? fallbackTail;
  const none: ArrowheadResult = { isArrow: false, tip: fallbackTip, tail: fallbackTail };
  if (points.length < 8 || pathLen < 40) return none;

  // Shaft direction from the leading 55%, before any barb can contaminate it.
  const shaftEnd = Math.max(2, Math.floor(points.length * 0.55));
  const shaft = fitLine(points.slice(0, shaftEnd));
  const dir = unit(shaft.direction);
  const oriented: Point =
    dot(sub(fallbackTip, fallbackTail), dir) >= 0 ? dir : [-dir[0], -dir[1]];

  let tipIdx = 0;
  let tipProj = -Infinity;
  const projections: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const proj = dot(sub(p, fallbackTail), oriented);
    projections.push(proj);
    if (proj > tipProj) {
      tipProj = proj;
      tipIdx = i;
    }
  }

  const arcToTip = pathLength(points.slice(0, tipIdx + 1));
  const tailLen = pathLen - arcToTip;
  if (arcToTip < pathLen * 0.45) return none;
  if (tailLen < pathLen * 0.06 || tailLen > pathLen * 0.5) return none;

  // Everything after the tip must fold back along the shaft, not continue past it.
  let maxAfter = -Infinity;
  for (let i = tipIdx + 1; i < projections.length; i++) {
    maxAfter = Math.max(maxAfter, projections[i] ?? -Infinity);
  }
  if (maxAfter > tipProj * 0.96) return none;

  // ...and it must contain at least one hard reversal, which is the barb.
  const tailPts = rdp(points.slice(tipIdx), pathLen * 0.02);
  let sharpTurns = 0;
  for (let i = 1; i < tailPts.length - 1; i++) {
    const a = tailPts[i - 1];
    const b = tailPts[i];
    const c = tailPts[i + 1];
    if (a && b && c && turnAngle(a, b, c) > 1.1) sharpTurns++;
  }
  if (sharpTurns < 1) return none;

  return { isArrow: true, tip: points[tipIdx] ?? fallbackTip, tail: fallbackTail };
}

function toLocal(points: readonly Point[]): { box: Box; points: Point[] } {
  const box = bbox(points);
  return { box, points: points.map((p) => [p[0] - box.x, p[1] - box.y] as Point) };
}

function emptyMetrics(pointCount: number): RecognitionMetrics {
  return {
    pointCount,
    pathLength: 0,
    diagonal: 0,
    gapRatio: 1,
    closed: false,
    corners: 0,
    circularity: 0,
    rectFill: 0,
    convexity: 0,
    lineResidual: Infinity,
    ellipseResidual: Infinity,
    polyDeviation: 1,
    quadSkew: 1,
    rightness: 0,
  };
}

/**
 * Classifies a hand-drawn stroke and returns an idealised replacement.
 *
 * Everything is scored as a soft membership rather than a chain of thresholds,
 * so the caller gets a calibrated confidence and can refuse to touch a stroke
 * it is not sure about. Silently rewriting a deliberate squiggle into a
 * rectangle is far worse than leaving a rough rectangle alone.
 */
export function recognizeStroke(
  raw: readonly Point[],
  options: RecognizeOptions = {},
): Recognition {
  const opts = { ...DEFAULTS, ...options };
  const pts = dedupe(raw, 0.6);

  const bail = (smoothed?: Point[]): Recognition => ({
    kind: "freedraw",
    confidence: 0,
    runnerUp: null,
    scores: {},
    box: bbox(raw),
    angle: 0,
    smoothed: smoothed ?? [...raw],
    metrics: emptyMetrics(raw.length),
  });

  if (pts.length < 3) return bail();

  const pathLen = pathLength(pts);
  const rawBox = bbox(pts);
  const diag = Math.hypot(rawBox.width, rawBox.height);
  if (pathLen < opts.minLength || diag < opts.minLength * 0.5) return bail();

  const first = pts[0] as Point;
  const last = pts[pts.length - 1] as Point;
  const gapRatio = dist(first, last) / pathLen;
  const closed =
    opts.hint === "closed" ? true : opts.hint === "open" ? false : gapRatio < 0.22;

  const samples = resample(pts, 64);
  const rect = normalizeRect(minAreaRect(samples));
  const area = polygonArea(samples);
  const perim = perimeter(samples);
  const circularity = perim > 0 ? (4 * Math.PI * area) / (perim * perim) : 0;
  const rectArea = Math.max(rect.width * rect.height, 1e-6);
  const rectFill = area / rectArea;
  const hullArea = Math.max(polygonArea(convexHull(samples)), 1e-6);
  const convexity = area / hullArea;

  const line = fitLine(samples);
  const lineResidual = line.residual / Math.max(diag, 1e-6);
  const ellipse = fitEllipse(samples);
  const ellipseResidual = ellipse.residual;

  const cornerEps = diag * 0.045;
  const corners = closed
    ? refineCorners(closedCorners(samples, cornerEps), diag)
    : rdp(samples, cornerEps);
  const cornerCount = closed ? corners.length : corners.length - 1;

  const angles = closed ? interiorAngles(corners) : [];
  const rightness = angles.length ? mean(angles.map((a) => gauss(a, Math.PI / 2, 0.3))) : 0;
  const polyDev = closed ? polygonDeviation(samples, corners, diag) : 1;
  const diagonals = corners.length === 4 ? quadDiagonals(corners, diag) : null;

  const metrics: RecognitionMetrics = {
    pointCount: pts.length,
    pathLength: pathLen,
    diagonal: diag,
    gapRatio,
    closed,
    corners: cornerCount,
    circularity,
    rectFill,
    convexity,
    lineResidual,
    ellipseResidual,
    polyDeviation: polyDev,
    quadSkew: diagonals?.skew ?? 1,
    rightness,
  };

  const scores: Partial<Record<ShapeKind, number>> = {};

  if (!closed) {
    scores.line = combine(
      [gauss(lineResidual, 0, 0.045), 3],
      [gauss(gapRatio, 1, 0.4), 1],
    );
    const head = detectArrowhead(pts, pathLen);
    if (head.isArrow) scores.arrow = combine([gauss(lineResidual, 0, 0.16), 1], [0.9, 2]);
    if (cornerCount >= 2 && cornerCount <= 6) {
      scores.polygon = combine(
        [gauss(polygonDeviation(samples, corners, diag), 0, 0.02), 2],
        [gauss(cornerCount, 3, 1.6), 1],
        [0.72, 1],
      );
    }
  } else {
    // --- curved --------------------------------------------------------
    // An ellipse simplifies to seven or eight corners at this epsilon, and its
    // samples bow away from every chord. Both facts separate it from a polygon
    // that happens to have a similar corner count.
    scores.ellipse = combine(
      [gauss(ellipseResidual, 0, 0.075), 3],
      [gauss(circularity, 1.0, 0.24), 1],
      [gauss(convexity, 1.0, 0.14), 1],
      [gauss(cornerCount, 8, 3.5), 1],
      [1 - clamp01(gauss(polyDev, 0, 0.012)), 1],
    );

    // --- straight-edged ------------------------------------------------
    const straightEdges = gauss(polyDev, 0, 0.016);

    if (cornerCount === 4 && diagonals) {
      const orientedCorners = rectCorners(rect);
      const rectFitness = corresponds(corners, orientedCorners, diag);

      // A rectangle: right angles at every corner, vertices flush with the
      // min-area rect. Both hold at any rotation.
      scores.rectangle = combine(
        [rightness, 3],
        [gauss(rectFitness, 0, 0.07), 3],
        [straightEdges, 2],
        [gauss(convexity, 1.0, 0.12), 1],
      );

      // A diamond: diagonals perpendicular and mutually bisecting. Deliberately
      // NOT tested via rectFill — a diamond's minimal enclosing rectangle hugs
      // its edges rather than its bounding box, so that ratio lands near 0.75
      // and overlaps the rectangle case completely.
      scores.diamond = combine(
        [gauss(diagonals.skew, 0, 0.22), 3],
        [gauss(diagonals.offset, 0, 0.05), 2],
        [straightEdges, 2],
        [gauss(convexity, 1.0, 0.12), 1],
      );
    }

    if (cornerCount === 3) {
      scores.triangle = combine(
        [straightEdges, 3],
        [gauss(rectFill, 0.5, 0.14), 2],
        [gauss(convexity, 1.0, 0.14), 1],
      );
    }

    if (cornerCount >= 5 && cornerCount <= 10) {
      scores.polygon = combine(
        [gauss(polyDev, 0, 0.009), 3],
        [gauss(convexity, 1.0, 0.13), 1],
        [0.8, 1],
      );
    }
  }

  const ranked = (Object.entries(scores) as [ShapeKind, number][])
    .filter(([, s]) => Number.isFinite(s) && s > 0)
    .sort((a, b) => b[1] - a[1]);

  const top = ranked[0];
  const second = ranked[1];
  if (!top || top[1] < opts.threshold) {
    return {
      ...bail(smoothGaussian(chaikin(pts, 1), 1.2)),
      scores,
      metrics,
      runnerUp: top?.[0] ?? null,
    };
  }

  const margin = top[1] - (second?.[1] ?? 0);
  const confidence = clamp01(top[1] * (0.7 + 0.3 * Math.min(1, margin / 0.2)));
  const kind = top[0];

  const shared = {
    kind,
    confidence,
    runnerUp: second?.[0] ?? null,
    scores,
    metrics,
  } as const;

  switch (kind) {
    case "line":
    case "arrow": {
      let start = line.start;
      let end = line.end;
      if (kind === "arrow") {
        const head = detectArrowhead(pts, pathLen);
        start = head.tail;
        end = head.tip;
      } else if (dist(first, line.start) > dist(first, line.end)) {
        [start, end] = [end, start];
      }
      const delta = sub(end, start);
      const len = Math.hypot(delta[0], delta[1]);
      const theta = snapAngle(Math.atan2(delta[1], delta[0]), opts.angleSnap);
      const snapped: Point = [
        start[0] + Math.cos(theta) * len,
        start[1] + Math.sin(theta) * len,
      ];
      const local = toLocal([start, snapped]);
      return { ...shared, box: local.box, angle: 0, points: local.points };
    }

    case "rectangle": {
      const theta = snapAngle(rect.angle, opts.angleSnap);
      if (theta === 0) {
        // Axis-aligned: the plain bbox hugs the stroke better than the calipers
        // rect, which is fit to the hull and so runs slightly wide.
        return { ...shared, box: rawBox, angle: 0 };
      }
      return {
        ...shared,
        box: {
          x: rect.cx - rect.width / 2,
          y: rect.cy - rect.height / 2,
          width: rect.width,
          height: rect.height,
        },
        angle: theta,
      };
    }

    case "diamond": {
      // Excalidraw inscribes a diamond in its box, so the box axes are the
      // diagonals: width along d1, height along d2.
      const d = diagonals;
      if (!d) return { ...shared, box: rawBox, angle: 0 };
      const [a, c] = d.d1;
      const axis = sub(c, a);
      const theta = snapAngle(Math.atan2(axis[1], axis[0]), opts.angleSnap);
      const width = d.lengths[0];
      const height = d.lengths[1];
      if (theta === 0) {
        return {
          ...shared,
          box: {
            x: d.center[0] - width / 2,
            y: d.center[1] - height / 2,
            width,
            height,
          },
          angle: 0,
        };
      }
      return {
        ...shared,
        box: {
          x: d.center[0] - width / 2,
          y: d.center[1] - height / 2,
          width,
          height,
        },
        angle: theta,
      };
    }

    case "ellipse": {
      const theta = snapAngle(ellipse.angle, opts.angleSnap);
      if (theta === 0 || Math.abs(theta) === Math.PI) {
        return { ...shared, box: rawBox, angle: 0 };
      }
      return {
        ...shared,
        box: {
          x: ellipse.cx - ellipse.rx,
          y: ellipse.cy - ellipse.ry,
          width: ellipse.rx * 2,
          height: ellipse.ry * 2,
        },
        angle: theta,
      };
    }

    case "triangle":
    case "polygon": {
      const verts = [...corners];
      if (closed && verts.length > 0) verts.push(verts[0] as Point);
      const local = toLocal(verts);
      return { ...shared, box: local.box, angle: 0, points: local.points };
    }

    default:
      return { ...shared, box: rawBox, angle: 0 };
  }
}
