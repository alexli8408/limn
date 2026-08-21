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
 *
 * The preserve-mode cases are the same fault in a different place: that mode
 * promises the author's arrangement and colours survive, so anything it moves or
 * repaints is a bug however good the new position or colour is.
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
  // still wins over the sketch's colour. The stroke only; the fill is the
  // author's, which the next test covers.
  const emphasised = skeletons.filter(
    (el) => el.type === "rectangle" && el.strokeColor === "#e03131",
  );
  assert.equal(emphasised.length, 1, "an emphasised node should keep its palette stroke");
});

test("emphasis in preserve mode restrokes a node without repainting its fill", () => {
  const FILL = "#ffc9c9";
  const existing = [
    sketch({ id: "a" }),
    sketch({ id: "b", x: 200 }),
    // n3 is the emphasised node, and the author filled it.
    sketch({ id: "c", x: 400, backgroundColor: FILL }),
  ];

  const { skeletons } = planDiagram(diagram(), { existing, ink: inkOf(existing) });
  const hot = skeletons.find((el) => el.strokeColor === "#e03131");

  assert.ok(hot, "the emphasised node should still take the palette stroke");
  assert.equal(
    hot.backgroundColor,
    FILL,
    "PALETTE's pale fill was painted over the colour the author chose",
  );
});

test("a note in preserve mode stays where it was written, in its own colour", () => {
  const WRITTEN_IN = "#e8590c";
  const existing = [
    sketch({ id: "a" }),
    sketch({ id: "b", x: 200 }),
    sketch({ id: "c", x: 400 }),
    // Off to one side and above the shapes, so the stacked fallback position is
    // nowhere near it and cannot pass by coincidence.
    sketch({
      id: "t",
      type: "text",
      x: 640,
      y: -120,
      width: 90,
      height: 20,
      strokeColor: WRITTEN_IN,
    }),
  ];

  const annotated = { ...diagram(), notes: [{ text: "check this", sourceIds: ["t"] }] };
  const { skeletons, replacedIds } = planDiagram(annotated as unknown as LimnDiagram, {
    existing,
    ink: inkOf(existing),
  });
  const note = skeletons.find((el) => el.type === "text");

  assert.ok(note, "the note should have compiled to a text element");
  assert.equal(note.x, 640);
  assert.equal(note.y, -120, "a preserved note was marched into a column under the diagram");
  assert.equal(note.strokeColor, WRITTEN_IN, "the note came back in house grey");
  assert.ok(replacedIds.includes("t"), "the original text still has to be tombstoned");
});

test("a note with nothing to ground it stacks, clear of the note above", () => {
  const existing = [sketch({ id: "a" }), sketch({ id: "b", x: 200 }), sketch({ id: "c", x: 400 })];
  const annotated = {
    ...diagram(),
    notes: [
      { text: "first line\nsecond line", sourceIds: [] },
      // A sourceId that resolves to nothing is the same as having none.
      { text: "after it", sourceIds: ["gone"] },
    ],
  };

  const { skeletons } = planDiagram(annotated as unknown as LimnDiagram, {
    existing,
    ink: inkOf(existing),
  });
  const texts = skeletons.filter((el) => el.type === "text");
  assert.equal(texts.length, 2);

  // Two lines at 16px is 40px tall, so the old flat 30px step drew the second
  // note through the first.
  const top = Number(texts[0]!.y);
  const below = Number(texts[1]!.y);
  assert.ok(below - top >= 40, `stacked notes overlap, only ${below - top}px apart`);
  assert.equal(texts[0]!.strokeColor, "#868e96", "a note we placed is house grey");
});

test("a sketch drawn in the default colour is unchanged by the ink path", () => {
  const existing = [sketch({ id: "a" }), sketch({ id: "b", x: 200 }), sketch({ id: "c", x: 400 })];
  const { skeletons } = planDiagram(diagram(), { existing, ink: inkOf(existing) });

  const arrow = skeletons.find((el) => el.type === "arrow");
  assert.equal(arrow?.strokeColor, "#1e1e1e");
});
