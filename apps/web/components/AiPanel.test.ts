import assert from "node:assert/strict";
import { test } from "vitest";
import { statsLine, tidiedSummary, type AiStats } from "./AiPanel";

/**
 * The panel's two sentences of arithmetic.
 *
 * Both used to describe a drawing in diagram words: the polish path makes no
 * nodes and no edges, and reporting a tidied house as "3 nodes · 0 edges" named
 * a thing the run had deliberately not built. The counts also never agreed with
 * their nouns, so a one-shape, one-group polish read "Tidied 1 shapes across 1
 * groups", wrong twice in the one line. Neither is caught by types, and both are
 * on screen for the whole of a demo.
 */

test("a polished drawing is reported in its own vocabulary", () => {
  const stats: AiStats = {
    kind: "drawing",
    groups: 3,
    shapes: 7,
    latencyMs: 1840,
    model: "gemini-3-pro",
  };
  assert.equal(statsLine(stats), "3 groups · 7 shapes · 1840ms · gemini-3-pro");
  assert.ok(!statsLine(stats).includes("node"));
  assert.ok(!statsLine(stats).includes("edge"));
});

test("one of a thing is singular, everywhere it is counted", () => {
  assert.equal(
    statsLine({ kind: "drawing", groups: 1, shapes: 1, latencyMs: 900, model: "gemini" }),
    "1 group · 1 shape · 900ms · gemini",
  );
  assert.equal(
    statsLine({ kind: "diagram", nodes: 1, edges: 1, aligned: 0, latencyMs: 40, model: "gemini" }),
    "1 node · 1 edge · 40ms · gemini",
  );
  assert.equal(tidiedSummary(1, 1), "Tidied 1 shape across 1 group.");
  assert.equal(tidiedSummary(7, 3), "Tidied 7 shapes across 3 groups.");
});

test("a rebuilt diagram keeps the line it always had", () => {
  assert.equal(
    statsLine({
      kind: "diagram",
      nodes: 5,
      edges: 4,
      aligned: 2,
      latencyMs: 2200,
      model: "gemini-3-pro",
    }),
    "5 nodes · 4 edges · 2 aligned · 2200ms · gemini-3-pro",
  );
  // Nothing aligned is left out rather than shown as a zero. Two boxes and the
  // arrow between them is the smallest diagram anyone demos, and it used to
  // report "1 edges".
  assert.equal(
    statsLine({ kind: "diagram", nodes: 2, edges: 1, aligned: 0, latencyMs: 10, model: "m" }),
    "2 nodes · 1 edge · 10ms · m",
  );
});
