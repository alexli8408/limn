import assert from "node:assert/strict";
import { test } from "vitest";
import { recognizeStroke, resample, type Point } from "@limn/shapes";

/**
 * The hero animation claims the recogniser turns each wobbly stroke into a
 * specific shape, and it renders whatever the classifier returns. If the
 * recogniser stops agreeing with the caption, the landing page starts
 * advertising behaviour the product does not have, silently and on the front
 * page. This pins the four figures it cycles through.
 *
 * Kept in step with buildFigures() in StrokeMorph.tsx by construction: same
 * seed, same amplitude, same sample count.
 */

const SAMPLES = 120;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wobble(points: Point[], rand: () => number, amount: number): Point[] {
  const phase = rand() * Math.PI * 2;
  return points.map(([x, y], i) => {
    const drift = Math.sin(phase + (i / points.length) * 6.5) * amount * 0.7;
    return [x + (rand() - 0.5) * amount + drift, y + (rand() - 0.5) * amount - drift] as Point;
  });
}

function tracePolygon(vertices: Point[]): Point[] {
  const out: Point[] = [];
  const loop = [...vertices, vertices[0] as Point];
  for (let i = 1; i < loop.length; i++) {
    const a = loop[i - 1] as Point;
    const b = loop[i] as Point;
    const steps = Math.max(8, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  out.push(loop[loop.length - 1] as Point);
  return out;
}

function traceEllipse(cx: number, cy: number, rx: number, ry: number): Point[] {
  return Array.from({ length: 110 }, (_, i) => {
    const t = (i / 109) * Math.PI * 2;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as Point;
  });
}

test("every hero figure is recognised as the shape it is captioned", () => {
  const rand = prng(0x5eed);
  const cases: [string, Point[]][] = [
    ["rectangle", tracePolygon([[40, 40], [220, 40], [220, 150], [40, 150]])],
    ["ellipse", traceEllipse(130, 95, 92, 58)],
    ["diamond", tracePolygon([[130, 34], [222, 95], [130, 156], [38, 95]])],
    ["triangle", tracePolygon([[130, 36], [222, 154], [38, 154]])],
  ];

  for (const [expected, shape] of cases) {
    const rough = resample(wobble(shape, rand, 6.5), SAMPLES);
    const result = recognizeStroke(rough);

    assert.equal(
      result.kind,
      expected,
      `hero would caption a ${expected} as "${result.kind}" (${Math.round(result.confidence * 100)}%)`,
    );
    assert.ok(
      result.confidence >= 0.6,
      `${expected} recognised at only ${Math.round(result.confidence * 100)}%, which looks weak on the front page`,
    );
    assert.ok(result.box.width > 0 && result.box.height > 0, `${expected} has no box to morph into`);
  }
});
