import assert from "node:assert/strict";
import test from "node:test";
import { recognizeStroke, type ShapeKind } from "./recognize.js";
import { alignBoxes } from "./align.js";
import type { Point } from "./vec.js";

/**
 * Recognition benchmark.
 *
 * The accuracy figure quoted in the README comes from this suite, not from a
 * guess. Strokes are synthesised with a seeded PRNG so the number is stable
 * across machines and a regression shows up as a failing test rather than as
 * "the shapes feel worse lately".
 */

/** mulberry32, small, fast, and good enough for jitter. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Wobble {
  rand: () => number;
  /** Perpendicular noise as a fraction of the shape's diagonal. */
  jitter: number;
}

/**
 * Walks a polygon's perimeter emitting samples, adding the artefacts a real
 * hand produces: per-point noise, a low-frequency drift (the wrist, not the
 * fingers), and an overshoot or gap at the closing seam.
 */
function tracePolygon(vertices: Point[], w: Wobble, closed = true): Point[] {
  const pts: Point[] = [];
  const loop = closed ? [...vertices, vertices[0] as Point] : vertices;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of vertices) {
    minX = Math.min(minX, v[0]);
    maxX = Math.max(maxX, v[0]);
    minY = Math.min(minY, v[1]);
    maxY = Math.max(maxY, v[1]);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const amp = diag * w.jitter;
  const driftPhase = w.rand() * Math.PI * 2;

  for (let i = 1; i < loop.length; i++) {
    const a = loop[i - 1] as Point;
    const b = loop[i] as Point;
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(6, Math.round(segLen / 3));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const drift = Math.sin(driftPhase + (i + t) * 1.7) * amp * 0.6;
      pts.push([
        a[0] + (b[0] - a[0]) * t + (w.rand() - 0.5) * amp + drift,
        a[1] + (b[1] - a[1]) * t + (w.rand() - 0.5) * amp - drift,
      ]);
    }
  }

  const end = loop[loop.length - 1] as Point;
  pts.push([end[0] + (w.rand() - 0.5) * amp, end[1] + (w.rand() - 0.5) * amp]);

  if (closed) {
    // Humans either stop short of the start or run past it. Both happen; both
    // have to survive the open/closed test.
    const overshoot = w.rand() < 0.5 ? w.rand() * 0.05 : -w.rand() * 0.03;
    if (overshoot > 0 && pts.length > 4) {
      const extra = Math.round(pts.length * overshoot);
      for (let i = 0; i < extra; i++) pts.push(pts[i] as Point);
    }
  }
  return pts;
}

function rotateAll(pts: Point[], angle: number, cx: number, cy: number): Point[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return pts.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c] as Point;
  });
}

interface Sample {
  kind: ShapeKind;
  points: Point[];
}

function makeSample(kind: ShapeKind, rand: () => number): Sample {
  const w = 90 + rand() * 220;
  const h = 70 + rand() * 200;
  const x = rand() * 400;
  const y = rand() * 400;
  const wobble: Wobble = { rand, jitter: 0.012 + rand() * 0.022 };

  switch (kind) {
    case "rectangle": {
      const verts: Point[] = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
      return { kind, points: tracePolygon(verts, wobble) };
    }
    case "diamond": {
      const verts: Point[] = [
        [x + w / 2, y],
        [x + w, y + h / 2],
        [x + w / 2, y + h],
        [x, y + h / 2],
      ];
      return { kind, points: tracePolygon(verts, wobble) };
    }
    case "triangle": {
      const verts: Point[] = [
        [x + w / 2, y],
        [x + w, y + h],
        [x, y + h],
      ];
      return { kind, points: tracePolygon(verts, wobble) };
    }
    case "ellipse": {
      const pts: Point[] = [];
      const steps = 90;
      const amp = Math.hypot(w, h) * wobble.jitter;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        pts.push([
          x + w / 2 + (w / 2) * Math.cos(t) + (rand() - 0.5) * amp,
          y + h / 2 + (h / 2) * Math.sin(t) + (rand() - 0.5) * amp,
        ]);
      }
      return { kind, points: pts };
    }
    case "line": {
      const angle = rand() * Math.PI * 2;
      const len = 120 + rand() * 260;
      const verts: Point[] = [
        [x, y],
        [x + Math.cos(angle) * len, y + Math.sin(angle) * len],
      ];
      return { kind, points: tracePolygon(verts, { ...wobble, jitter: 0.006 }, false) };
    }
    default:
      throw new Error(`no generator for ${kind}`);
  }
}

const KINDS: ShapeKind[] = ["rectangle", "ellipse", "diamond", "triangle", "line"];
const PER_KIND = 120;

test("recognises hand-drawn primitives with high accuracy", () => {
  const rand = prng(0xc0ffee);
  const confusion = new Map<string, number>();
  let correct = 0;
  let total = 0;
  let lowConfidence = 0;

  for (const kind of KINDS) {
    for (let i = 0; i < PER_KIND; i++) {
      let sample = makeSample(kind, rand);
      // Rotate a third of the closed shapes; axis-aligned-only recognition is
      // easy and not representative of how people actually draw.
      if (kind !== "line" && i % 3 === 0) {
        const angle = (rand() - 0.5) * 0.8;
        sample = {
          ...sample,
          points: rotateAll(sample.points, angle, 200, 200),
        };
      }

      const result = recognizeStroke(sample.points);
      total++;
      if (result.kind === kind) correct++;
      else {
        const key = `${kind}->${result.kind}`;
        confusion.set(key, (confusion.get(key) ?? 0) + 1);
      }
      if (result.confidence < 0.55) lowConfidence++;
    }
  }

  const accuracy = correct / total;
  const summary = [...confusion.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `recognition: ${(accuracy * 100).toFixed(1)}% over ${total} strokes` +
      (summary ? ` | misses: ${summary}` : ""),
  );

  // Floor set a little under the measured 95.8% so ordinary tuning noise does
  // not fail the build, but a real regression does.
  assert.ok(
    accuracy >= 0.93,
    `accuracy ${(accuracy * 100).toFixed(1)}% below 93% floor (${summary})`,
  );
  assert.ok(lowConfidence / total < 0.2, "too many low-confidence recognitions");
});

test("leaves deliberate squiggles alone", () => {
  const rand = prng(7);
  const pts: Point[] = [];
  for (let i = 0; i < 200; i++) {
    const t = i / 20;
    pts.push([t * 18 + rand() * 4, Math.sin(t * 2.3) * 60 + Math.cos(t * 5.1) * 25]);
  }
  const result = recognizeStroke(pts);
  assert.equal(result.kind, "freedraw");
  assert.ok(result.smoothed && result.smoothed.length > 0, "smoothed fallback missing");
});

test("ignores taps and hairline strokes", () => {
  assert.equal(recognizeStroke([[0, 0]]).kind, "freedraw");
  assert.equal(
    recognizeStroke([
      [10, 10],
      [11, 11],
      [12, 10],
    ]).kind,
    "freedraw",
  );
});

test("alignBoxes snaps a near-row into a true row with even gaps", () => {
  const before = [
    { x: 0, y: 100, width: 120, height: 60 },
    { x: 168, y: 104, width: 118, height: 62 },
    { x: 330, y: 97, width: 121, height: 59 },
  ];
  const { boxes, moved, rows } = alignBoxes(before);

  assert.equal(rows, 1);
  assert.ok(moved.length >= 2, "expected the off-baseline boxes to move");

  const ys = boxes.map((b) => b.y + b.height / 2);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 0.6, "row not aligned");

  const widths = new Set(boxes.map((b) => b.width));
  assert.equal(widths.size, 1, "near-equal widths were not equalised");

  const gapA = (boxes[1]?.x ?? 0) - ((boxes[0]?.x ?? 0) + (boxes[0]?.width ?? 0));
  const gapB = (boxes[2]?.x ?? 0) - ((boxes[1]?.x ?? 0) + (boxes[1]?.width ?? 0));
  assert.ok(Math.abs(gapA - gapB) <= 4, `gaps not evened: ${gapA} vs ${gapB}`);
});

test("alignBoxes preserves deliberate clustering", () => {
  // Two tight pairs far apart: evening these gaps would destroy the grouping.
  const before = [
    { x: 0, y: 0, width: 80, height: 40 },
    { x: 90, y: 0, width: 80, height: 40 },
    { x: 600, y: 0, width: 80, height: 40 },
  ];
  const { boxes } = alignBoxes(before, { distribute: true });
  assert.ok((boxes[2]?.x ?? 0) > 400, "distant box was pulled into the cluster");
});
