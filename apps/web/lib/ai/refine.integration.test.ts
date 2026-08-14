import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
import { hasGeminiKey, liveCheck, loadEnv } from "./live-test";
import type { SketchElement } from "./gemini";

/**
 * The case that exposed the design fault: a stick figure with a smiley face and
 * the handwritten word "ball", with the instruction "make it look animated".
 *
 * The first version answered with two ellipses labelled "ball" and "actor". The
 * IR only had rectangle/ellipse/diamond nodes and edges, and the prompt said to
 * read an ellipse as "a start/end or an actor", so a drawing of a person had
 * literally nowhere else to land. The model behaved correctly; the vocabulary
 * was wrong, and the tool destroyed the sketch to fit it.
 *
 * A beautifier that cannot say "this is not a diagram" will mangle every drawing
 * it is handed, so that is what these assert.
 */

loadEnv(import.meta.dirname);
const hasKey = hasGeminiKey();

const fixture = (name: string): string =>
  readFileSync(resolve(import.meta.dirname, "__fixtures__", name)).toString("base64");

/** Roughly what Excalidraw would report for that drawing. */
const STICK_FIGURE: SketchElement[] = [
  { id: "head", type: "ellipse", x: 138, y: 68, width: 104, height: 104 },
  { id: "eye-l", type: "ellipse", x: 167, y: 103, width: 10, height: 10 },
  { id: "eye-r", type: "ellipse", x: 203, y: 103, width: 10, height: 10 },
  { id: "smile", type: "freedraw", x: 164, y: 118, width: 52, height: 22 },
  { id: "body", type: "line", x: 190, y: 172, width: 0, height: 110 },
  { id: "arm-l", type: "line", x: 128, y: 202, width: 62, height: 48 },
  { id: "arm-r", type: "line", x: 190, y: 202, width: 62, height: 48 },
  { id: "leg-l", type: "line", x: 138, y: 282, width: 52, height: 80 },
  { id: "leg-r", type: "line", x: 190, y: 282, width: 52, height: 80 },
  { id: "word", type: "text", x: 400, y: 140, width: 108, height: 48, text: "ball" },
];

test.skipIf(!hasKey)(
  "declines a drawing instead of forcing it into boxes",
  async () => liveCheck(async () => {
    const { refineSketch } = await import("./gemini");

    const { diagram, meta } = await refineSketch({
      elements: STICK_FIGURE,
      imageBase64: fixture("stick-figure-ball.png"),
      instruction: "make it look animated",
    });

    console.log(
      `  kind=${diagram.kind} nodes=${diagram.nodes.length} edges=${diagram.edges.length} ` +
        `model=${meta.model} ${meta.latencyMs}ms`,
    );
    console.log(`  rationale: ${diagram.rationale}`);
    for (const n of diagram.nodes) console.log(`    node: ${n.shape} "${n.label}"`);

    assert.equal(
      diagram.kind,
      "drawing",
      `a stick figure and a word is not a diagram, but it returned ` +
        `${diagram.nodes.length} nodes: ${diagram.nodes.map((n) => n.label).join(", ")}`,
    );
    assert.equal(diagram.nodes.length, 0, "a declined sketch must propose no nodes");

    // The specific failure that started this: inventing a generic role label for
    // a picture of a person.
    const labels = diagram.nodes.map((n) => n.label.toLowerCase());
    assert.ok(!labels.includes("actor"), 'relabelled the figure as "actor"');
  }),
  90_000,
);

test.skipIf(!hasKey)(
  "still recognises a real flowchart",
  async () => liveCheck(async () => {
    const { refineSketch } = await import("./gemini");

    // Two boxes joined by an arrow, with labels. Unambiguously a diagram, so
    // declining here would mean the guard is simply refusing everything.
    const flow: SketchElement[] = [
      { id: "b1", type: "rectangle", x: 40, y: 60, width: 200, height: 90 },
      { id: "t1", type: "text", x: 70, y: 95, width: 140, height: 24, text: "collect input", containerId: "b1" },
      { id: "b2", type: "rectangle", x: 400, y: 60, width: 200, height: 90 },
      { id: "t2", type: "text", x: 430, y: 95, width: 140, height: 24, text: "store result", containerId: "b2" },
      { id: "a1", type: "arrow", x: 240, y: 105, width: 160, height: 0 },
      { id: "d1", type: "diamond", x: 200, y: 240, width: 200, height: 120 },
      { id: "t3", type: "text", x: 240, y: 290, width: 120, height: 24, text: "valid?", containerId: "d1" },
      { id: "a2", type: "arrow", x: 140, y: 150, width: 160, height: 90 },
    ];

    const { diagram } = await refineSketch({
      elements: flow,
      imageBase64: fixture("flowchart.png"),
    });

    console.log(
      `  kind=${diagram.kind} nodes=${diagram.nodes.length} edges=${diagram.edges.length}`,
    );
    assert.notEqual(diagram.kind, "drawing", "refused an actual flowchart");
    assert.ok(diagram.nodes.length >= 2, `only ${diagram.nodes.length} nodes`);
  }),
  90_000,
);
