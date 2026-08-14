"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { recognizeStroke, resample, type Point } from "@limn/shapes";

/**
 * The hero animation: a wobbly stroke settling into the shape it was meant to be.
 *
 * It runs the real recogniser from `@limn/shapes`, the same code the canvas uses
 * on every stroke. The clean shape is not drawn by hand here; it is whatever the
 * classifier returns for the wobbly input, so the page cannot advertise
 * behaviour the product does not have. If the recogniser regresses, this breaks.
 */

const SAMPLES = 120;

/** mulberry32, so the same wobble renders on the server and the client. */
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
    return [
      x + (rand() - 0.5) * amount + drift,
      y + (rand() - 0.5) * amount - drift,
    ] as Point;
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

/** The idealised outline for whatever the recogniser decided this stroke is. */
function idealOutline(kind: string, box: { x: number; y: number; width: number; height: number }): Point[] {
  const { x, y, width: w, height: h } = box;
  switch (kind) {
    case "ellipse":
      return traceEllipse(x + w / 2, y + h / 2, w / 2, h / 2);
    case "diamond":
      return tracePolygon([
        [x + w / 2, y],
        [x + w, y + h / 2],
        [x + w / 2, y + h],
        [x, y + h / 2],
      ]);
    case "triangle":
      return tracePolygon([
        [x + w / 2, y],
        [x + w, y + h],
        [x, y + h],
      ]);
    default:
      return tracePolygon([
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ]);
  }
}

interface Figure {
  rough: Point[];
  clean: Point[];
  kind: string;
  confidence: number;
}

function buildFigures(): Figure[] {
  const rand = prng(0x5eed);
  const shapes: Point[][] = [
    tracePolygon([
      [40, 40],
      [220, 40],
      [220, 150],
      [40, 150],
    ]),
    traceEllipse(130, 95, 92, 58),
    tracePolygon([
      [130, 34],
      [222, 95],
      [130, 156],
      [38, 95],
    ]),
    tracePolygon([
      [130, 36],
      [222, 154],
      [38, 154],
    ]),
  ];

  return shapes.map((shape) => {
    const rough = resample(wobble(shape, rand, 6.5), SAMPLES);
    const result = recognizeStroke(rough);
    const kind = result.kind === "freedraw" ? "rectangle" : result.kind;
    return {
      rough,
      clean: resample(idealOutline(kind, result.box), SAMPLES),
      kind,
      confidence: result.confidence,
    };
  });
}

const toPath = (points: Point[]): string =>
  points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") + " Z";

const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export default function StrokeMorph() {
  const figures = useMemo(buildFigures, []);
  const [index, setIndex] = useState(0);
  const [t, setT] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setT(1);
      return;
    }

    let start = performance.now();
    let phase: "hold-rough" | "morph" | "hold-clean" = "hold-rough";

    const tick = (now: number) => {
      const elapsed = now - start;
      if (phase === "hold-rough" && elapsed > 900) {
        phase = "morph";
        start = now;
      } else if (phase === "morph") {
        const p = Math.min(1, elapsed / 850);
        setT(easeInOut(p));
        if (p >= 1) {
          phase = "hold-clean";
          start = now;
        }
      } else if (phase === "hold-clean" && elapsed > 1700) {
        setIndex((i) => (i + 1) % figures.length);
        setT(0);
        phase = "hold-rough";
        start = now;
      }
      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [figures.length]);

  const figure = figures[index] as Figure;
  const blended = figure.rough.map((p, i) => {
    const q = figure.clean[i] as Point;
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] as Point;
  });

  return (
    <figure className="morph" aria-label="A hand-drawn stroke snapping to a clean shape">
      <div className="specimen-head">
        <span>specimen {String(index + 1).padStart(2, "0")}/{String(figures.length).padStart(2, "0")}</span>
        <span>live recogniser</span>
      </div>
      <svg viewBox="0 0 260 190" role="img">
        <path
          d={toPath(blended)}
          fill="none"
          /* Flat accent, not a gradient. */
          stroke="var(--ink-accent-hot)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <figcaption>
        <span className="dot" style={{ opacity: t > 0.9 ? 1 : 0.2 }} />
        {t > 0.9
          ? `${figure.kind} · ${Math.round(figure.confidence * 100)}% confidence`
          : "freehand stroke"}
      </figcaption>
    </figure>
  );
}
