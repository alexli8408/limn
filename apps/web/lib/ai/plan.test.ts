import assert from "node:assert/strict";
import { test } from "vitest";
import type { SyncElement } from "@limn/protocol";
import { planDiagram, inkOf } from "./plan";
import type { LimnDiagram } from "./schema";

/**
 * Clean-up used to hand back a black diagram whatever you drew in, because the
 * compiler carried a fixed palette and the schema never asked the model about
 * colour. Redrawing someone's red sketch in black reads as the feature taking
 * their work away rather than tidying it, so this pins the colour path.
 */

function sketch(partial: Partial<SyncElement> & { id: string }): SyncElement {
  return {
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    ...partial,
  } as unknown as SyncElement;
}

const diagram = (): LimnDiagram =>
  ({
    kind: "diagram",
    layout: "preserve",
    rationale: "",
    notes: [],
    nodes: [
      { id: "n1", label: "one", shape: "rectangle", emphasis: "normal", sourceIds: ["a"] },
      { id: "n2", label: "two", shape: "rectangle", emphasis: "normal", sourceIds: ["b"] },
      { id: "n3", label: "hot", shape: "rectangle", emphasis: "danger", sourceIds: ["c"] },
    ],
    edges: [
      { from: "n1", to: "n2", label: "", style: "solid", directed: true, sourceIds: [] },
    ],
  }) as unknown as LimnDiagram;

test("inkOf takes the majority colour, ignoring tombstones", () => {
  const ink = inkOf([
    sketch({ id: "a", strokeColor: "#e03131" }),
    sketch({ id: "b", strokeColor: "#e03131" }),
    sketch({ id: "c", strokeColor: "#1971c2" }),
    // A deleted element is not on screen, so it does not get a vote.
    sketch({ id: "d", strokeColor: "#2f9e44", isDeleted: true }),
    sketch({ id: "e", strokeColor: "#2f9e44", isDeleted: true }),
    sketch({ id: "f", strokeColor: "#2f9e44", isDeleted: true }),
  ]);

  assert.equal(ink.stroke, "#e03131");
  assert.equal(ink.background, "transparent");
});

test("inkOf falls back to Excalidraw's defaults on an empty scene", () => {
  const ink = inkOf([]);
  assert.equal(ink.stroke, "#1e1e1e");
  assert.equal(ink.background, "transparent");
});

test("a coloured sketch is redrawn in that colour, nodes and arrows alike", () => {
  // Deliberately not #e03131: that is PALETTE.danger.stroke, so a node given
  // the sketch's ink and a node given the danger palette would be
  // indistinguishable and the test would pass without proving anything.
  const INK = "#d6336c";
  const existing = [
    sketch({ id: "a", strokeColor: INK, x: 0 }),
    sketch({ id: "b", strokeColor: INK, x: 200 }),
    sketch({ id: "c", strokeColor: INK, x: 400 }),
  ];

  const { skeletons } = planDiagram(diagram(), {
    existing,
    ink: inkOf(existing),
  });

  const arrows = skeletons.filter((el) => el.type === "arrow");
  assert.ok(arrows.length > 0, "expected the edge to compile to an arrow");
  for (const arrow of arrows) {
    assert.equal(arrow.strokeColor, INK, "arrow ignored the sketch's ink");
  }

  // n1 and n2 are unemphasised, so they keep the sketch's colour.
  const plain = skeletons.filter(
    (el) => el.type === "rectangle" && el.strokeColor === INK,
  );
  assert.equal(plain.length, 2, "unemphasised nodes should keep the user's ink");

  // n3 asked for danger, which is a deliberate semantic choice by the model and
  // still wins over the sketch's colour.
  const emphasised = skeletons.filter(
    (el) => el.type === "rectangle" && el.backgroundColor === "#fff5f5",
  );
  assert.equal(emphasised.length, 1, "an emphasised node should keep its palette");
});

test("a sketch drawn in the default colour is unchanged by the ink path", () => {
  const existing = [sketch({ id: "a" }), sketch({ id: "b", x: 200 }), sketch({ id: "c", x: 400 })];
  const { skeletons } = planDiagram(diagram(), { existing, ink: inkOf(existing) });

  const arrow = skeletons.find((el) => el.type === "arrow");
  assert.equal(arrow?.strokeColor, "#1e1e1e");
});
