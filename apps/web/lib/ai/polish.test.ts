import assert from "node:assert/strict";
import { test } from "vitest";
import type { SyncElement } from "@limn/protocol";
import { polishSketch } from "./polish";
import type { PolishGroup } from "./schema";

/**
 * Clean-up used to decline anything that was not boxes and arrows, because the
 * only thing the model could return was nodes and edges. Polish is the answer
 * for everything else, and it earns that by never destroying anything: the
 * diagram path replaces the sketch it understood, this one only ever nudges the
 * sketch it was told about. So most of what is pinned here is what must NOT
 * happen, a stroke going missing, an id the model invented throwing, a bound
 * arrow moving twice, an edit that never reaches another peer.
 */

function sketch(partial: Partial<SyncElement> & { id: string }): SyncElement {
  return {
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    strokeColor: "#1e1e1e",
    strokeWidth: 2,
    roughness: 1,
    backgroundColor: "transparent",
    ...partial,
  } as unknown as SyncElement;
}

const group = (ids: string[], ops: string[], label = "the thing"): PolishGroup =>
  ({ ids, label, ops }) as unknown as PolishGroup;

/**
 * A hand-drawn circle, roughly 100 by 96, anchored on its first point the way
 * Excalidraw stores a stroke. The wobble is deterministic, so a threshold that
 * drifts fails here every run rather than one in ten.
 */
function drawnCircle(): [number, number][] {
  const wobble = (i: number) => ((i * 7919) % 11) / 5 - 1;
  const raw: [number, number][] = [];
  for (let i = 0; i < 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    raw.push([Math.cos(t) * 50 + wobble(i), Math.sin(t) * 48 + wobble(i + 3)]);
  }
  const first = raw[0] as [number, number];
  return raw.map(([x, y]) => [x - first[0], y - first[1]] as [number, number]);
}

const byId = (elements: readonly SyncElement[], id: string): SyncElement => {
  const found = elements.find((el) => el.id === id);
  assert.ok(found, `expected ${id} to still be in the scene`);
  return found;
};

test("the scene keeps every element it started with", () => {
  const scene = [
    sketch({ id: "a" }),
    sketch({ id: "b", x: 40 }),
    sketch({ id: "c", x: 90, type: "freedraw", points: [[0, 0], [10, 4], [20, -3], [30, 1]] }),
    sketch({ id: "d", isDeleted: true }),
  ];

  const result = polishSketch(scene, [
    group(["a", "b", "c", "d"], ["align-left", "equalize-size", "straighten", "match-style"]),
  ]);

  assert.equal(result.elements.length, scene.length);
  assert.deepEqual(
    result.elements.map((el) => el.id),
    ["a", "b", "c", "d"],
  );
  // A tombstone is the one thing polish may never create: the caller applies this
  // straight to the canvas, and a lost stroke is worse than an untidy one.
  assert.equal(result.elements.filter((el) => el.isDeleted).length, 1);
});

test("ids the model invented are ignored rather than thrown on", () => {
  const scene = [sketch({ id: "a" }), sketch({ id: "b", x: 40 })];

  const result = polishSketch(scene, [
    group(["ghost-1", "ghost-2"], ["align-left"]),
    group(["a", "b", "ghost-3"], ["align-left"]),
  ]);

  assert.equal(byId(result.elements, "b").x, 0, "the two real ids should still align");
  // The all-hallucinated group did nothing, so it must not be counted as work.
  assert.equal(result.groups, 1);
});

test("an id in two groups is handled by the first group only", () => {
  const scene = [
    sketch({ id: "a", x: 0 }),
    sketch({ id: "b", x: 50 }),
    sketch({ id: "c", x: 200 }),
  ];

  const result = polishSketch(scene, [
    group(["a", "b"], ["align-left"]),
    group(["b", "c"], ["align-left"]),
  ]);

  assert.equal(byId(result.elements, "b").x, 0, "b belongs to the first group");
  // The second group is left holding one member, and one element cannot be
  // aligned with itself, so c must not have been dragged onto b's edge.
  assert.equal(byId(result.elements, "c").x, 200);
  assert.deepEqual(result.changed, ["b"]);
  assert.equal(result.groups, 1);
});

test("align-left puts the members on a shared x and bumps only those versions", () => {
  const scene = [
    sketch({ id: "a", x: 12 }),
    sketch({ id: "b", x: 37 }),
    sketch({ id: "c", x: 82 }),
    sketch({ id: "outside", x: 400 }),
  ];

  const result = polishSketch(scene, [group(["a", "b", "c"], ["align-left"])]);

  const xs = ["a", "b", "c"].map((id) => byId(result.elements, id).x);
  assert.deepEqual(xs, [12, 12, 12]);

  // Without a higher version and a new nonce the sync layer reads this as the
  // element it already holds and the edit reaches nobody.
  for (const id of ["b", "c"]) {
    const el = byId(result.elements, id);
    assert.equal(el.version, 2, `${id} should have a bumped version`);
    assert.notEqual(el.versionNonce, 1, `${id} should have a fresh nonce`);
  }

  // a was already flush left, so nothing about it changed and it must not be
  // republished. Identity, because an untouched element is returned as-is.
  assert.equal(result.elements[0], scene[0]);
  assert.equal(result.elements[3], scene[3]);
  assert.deepEqual(result.changed, ["b", "c"]);
});

test("a bound arrow is left where it is, not moved a second time", () => {
  const scene = [
    sketch({ id: "a", x: 40 }),
    sketch({
      id: "b",
      x: 300,
      boundElements: [{ id: "arrow", type: "arrow" }],
    }),
    sketch({
      id: "arrow",
      type: "arrow",
      x: 140,
      y: 30,
      width: 160,
      height: 0,
      points: [[0, 0], [160, 0]],
      startBinding: { elementId: "a", focus: 0, gap: 4 },
      endBinding: { elementId: "b", focus: 0, gap: 4 },
    }),
  ];

  const result = polishSketch(scene, [group(["a", "b", "arrow"], ["align-left"])]);

  assert.equal(byId(result.elements, "b").x, 40, "the shapes still align");
  // Excalidraw re-routes a bound arrow from its endpoints. Translating it here
  // as well applies the same move twice and detaches it from both shapes.
  assert.equal(result.elements[2], scene[2]);
  assert.ok(!result.changed.includes("arrow"));
});

test("bound text rides with its container and is never a member itself", () => {
  const scene = [
    sketch({ id: "a", x: 40, y: 10 }),
    sketch({
      id: "box",
      x: 300,
      y: 200,
      boundElements: [{ id: "label", type: "text" }],
    }),
    sketch({ id: "label", type: "text", x: 310, y: 220, containerId: "box", width: 40, height: 20 }),
  ];

  // The model listing the label alongside its container is exactly the case that
  // would otherwise move it twice, once as a member and once with the box.
  const result = polishSketch(scene, [group(["a", "box", "label"], ["align-left"])]);

  const box = byId(result.elements, "box");
  const label = byId(result.elements, "label");
  assert.equal(box.x, 40);
  assert.equal(label.x, 50, "the label keeps its offset inside the box");
  assert.equal(label.y, 220, "and does not move on the axis the box did not");
  assert.equal(label.version, 2, "a moved label still has to sync");
});

test("straighten fits a wobbly stroke to one segment", () => {
  const scene = [
    sketch({
      id: "wall",
      type: "freedraw",
      x: 100,
      y: 100,
      width: 40,
      height: 6,
      points: [[0, 0], [10, 3], [20, -2], [30, 4], [40, 0]],
      pressures: [0.5, 0.5, 0.5, 0.5, 0.5],
      simulatePressure: false,
    }),
  ];

  // One member: alignment is meaningless, straighten is not.
  const result = polishSketch(scene, [group(["wall"], ["align-left", "straighten"])]);
  const wall = byId(result.elements, "wall");
  const points = wall.points as [number, number][];

  assert.equal(points.length, 2);
  assert.deepEqual(points[0], [0, 0], "Excalidraw anchors a stroke on its first point");
  assert.ok(Math.abs((points[1]?.[0] ?? 0) - 40) <= 2, "the run of the stroke survives");
  assert.ok(Math.abs(points[1]?.[1] ?? 99) <= 2, "the wobble does not");
  // One pressure per point, so a rewritten stroke keeping five of them renders
  // with the taper of a stroke that no longer exists.
  assert.deepEqual(wall.pressures, []);
  assert.equal(wall.simulatePressure, true);
  assert.equal(result.groups, 1);
});

test("straighten refuses a closed stroke, so the group does not lose its window", () => {
  const scene = [
    sketch({
      id: "wall",
      type: "freedraw",
      width: 40,
      height: 6,
      points: [[0, 0], [10, 3], [20, -2], [30, 4], [40, 0]],
    }),
    sketch({
      id: "window",
      type: "freedraw",
      x: 200,
      y: 200,
      width: 100,
      height: 96,
      points: drawnCircle(),
    }),
  ];

  // "the front of the house" is one group and an op applies to all of it. The
  // wall is a stroke aiming at a segment. The window is not, and fitting it to
  // one leaves two points where a window used to be.
  const result = polishSketch(scene, [group(["wall", "window"], ["straighten"])]);

  assert.equal((byId(result.elements, "wall").points as unknown[]).length, 2);
  assert.equal(result.elements[1], scene[1], "the window is left alone, not flattened");
  assert.deepEqual(result.changed, ["wall"]);
});

test("straighten does not undo the regularize that ran before it", () => {
  const scene = [
    sketch({
      id: "sun",
      type: "freedraw",
      x: 200,
      y: 200,
      width: 100,
      height: 96,
      points: drawnCircle(),
    }),
  ];

  const result = polishSketch(scene, [group(["sun"], ["straighten", "regularize"])]);
  const sun = byId(result.elements, "sun");

  // The clean circle regularize writes is closed, which is the same property
  // that makes straighten leave a hand-drawn one alone.
  assert.ok((sun.points as unknown[]).length > 4, "the circle survives both ops");
  assert.equal(sun.width, sun.height);
});

test("regularize squares a near-square box and leaves an oblong alone", () => {
  const scene = [
    sketch({ id: "square-ish", x: 0, y: 0, width: 100, height: 92, angle: 0.05 }),
    sketch({ id: "oblong", x: 400, y: 0, width: 200, height: 60 }),
  ];

  const result = polishSketch(scene, [group(["square-ish", "oblong"], ["regularize"])]);

  const squared = byId(result.elements, "square-ish");
  assert.equal(squared.width, 96);
  assert.equal(squared.height, 96);
  // Resized about the centre, so it does not appear to jump as it squares up.
  assert.equal(squared.x, 2);
  assert.equal(squared.y, -2);
  // Three degrees off true is a slip, not a design.
  assert.equal(squared.angle, 0);

  assert.equal(result.elements[1], scene[1], "a deliberate oblong is not a failed square");
});

test("regularize redraws a hand-drawn circle as a circle, without changing its type", () => {
  const scene = [
    sketch({
      id: "sun",
      type: "freedraw",
      x: 200,
      y: 200,
      width: 100,
      height: 96,
      points: drawnCircle(),
    }),
  ];

  const result = polishSketch(scene, [group(["sun"], ["regularize"])]);
  const sun = byId(result.elements, "sun");

  assert.equal(sun.type, "freedraw", "the element is cleaned, not replaced");
  assert.equal(sun.width, sun.height, "a near-circle comes back as a circle");
  assert.ok((sun.points as unknown[]).length > 4, "and still traces a closed path");
  assert.deepEqual((sun.points as [number, number][])[0], [0, 0]);
});

test("equalize-size makes lines the same length without turning them", () => {
  /**
   * Sun rays: one straight up, one straight out, one diagonal. They should end
   * up the same LENGTH and still point where they pointed.
   *
   * The first version of this op wrote the group's median width and median
   * height onto every member. Both medians are healthy here, so the vertical ray
   * was stretched from 3px wide to the median and came back a 45 degree
   * diagonal. Changing the direction of a stroke is not a size change.
   */
  const line = (id: string, x: number, y: number, dx: number, dy: number) =>
    sketch({
      id,
      type: "freedraw",
      x,
      y,
      width: Math.abs(dx),
      height: Math.abs(dy),
      points: [
        [0, 0],
        [dx, dy],
      ],
    });

  const existing = [
    line("up", 700, 60, 3, 40), // essentially vertical
    line("out", 790, 180, 36, 3), // essentially horizontal
    line("diag", 760, 100, 26, 26), // genuinely diagonal
  ];

  const { elements } = polishSketch(existing, [group(["up", "out", "diag"], ["equalize-size"])]);
  const by = new Map(elements.map((el) => [String(el.id), el]));

  const up = by.get("up");
  const out = by.get("out");
  assert.ok(up && out);

  // Still pointing the way they were drawn.
  assert.ok(
    Number(up.height) > Number(up.width) * 3,
    `the vertical ray came back ${Number(up.width)} by ${Number(up.height)}`,
  );
  assert.ok(
    Number(out.width) > Number(out.height) * 3,
    `the horizontal ray came back ${Number(out.width)} by ${Number(out.height)}`,
  );

  // And agreeing on length, which is the only size a line has.
  const length = (el: SyncElement) => Math.hypot(Number(el.width), Number(el.height));
  const lengths = ["up", "out", "diag"].map((id) => length(by.get(id) as SyncElement));
  const spread = Math.max(...lengths) - Math.min(...lengths);
  assert.ok(spread <= 2, `lengths still disagree: ${lengths.map((n) => n.toFixed(0)).join(", ")}`);
});

test("equalize-size gives every member the middle size, not the biggest", () => {
  const scene = [
    sketch({ id: "a", x: 0, y: 0, width: 100, height: 60 }),
    sketch({ id: "b", x: 200, y: 0, width: 104, height: 64 }),
    sketch({ id: "c", x: 400, y: 0, width: 400, height: 200 }),
  ];

  const result = polishSketch(scene, [group(["a", "b", "c"], ["equalize-size"])]);

  for (const id of ["a", "b", "c"]) {
    const el = byId(result.elements, id);
    assert.equal(el.width, 104);
    assert.equal(el.height, 64);
  }
  // One oversized member must not inflate the group, which is why the target is
  // a median and c is the one that moves furthest.
  assert.equal(byId(result.elements, "c").x, 548);
});

test("equalize-size evens the axis the group actually has", () => {
  const scene = [
    sketch({ id: "l", type: "line", x: 0, width: 0, height: 80, points: [[0, 0], [0, 80]] }),
    sketch({ id: "m", type: "line", x: 40, width: 0, height: 100, points: [[0, 0], [0, 100]] }),
    sketch({ id: "r", type: "line", x: 80, width: 0, height: 120, points: [[0, 0], [0, 120]] }),
  ];

  // Railings: every member is 0 wide, so there is no width to agree on. Judging
  // the two axes together meant a group like this got nothing done to it.
  const result = polishSketch(scene, [group(["l", "m", "r"], ["equalize-size"])]);

  for (const id of ["l", "m", "r"]) {
    const el = byId(result.elements, id);
    assert.equal(el.height, 100, `${id} should take the median height`);
    assert.equal(el.width, 0, `${id} should not be given a width it never had`);
  }
  // Resized about the centre, so the short one grows at both ends.
  assert.equal(byId(result.elements, "l").y, -10);
});

test("distribute-x evens the gaps and leaves the outermost members alone", () => {
  const scene = [
    sketch({ id: "a", x: 0, width: 100 }),
    sketch({ id: "b", x: 130, width: 100 }),
    sketch({ id: "c", x: 400, width: 100 }),
  ];

  const result = polishSketch(scene, [group(["a", "b", "c"], ["distribute-x"])]);

  assert.equal(byId(result.elements, "a").x, 0);
  assert.equal(byId(result.elements, "b").x, 200);
  assert.equal(byId(result.elements, "c").x, 400);
});

test("match-style takes the majority, so one stray does not repaint the group", () => {
  const scene = [
    sketch({ id: "a", strokeColor: "#1e1e1e", strokeWidth: 2, roughness: 1 }),
    sketch({ id: "b", x: 200, strokeColor: "#1e1e1e", strokeWidth: 2, roughness: 1 }),
    sketch({ id: "c", x: 400, strokeColor: "#e03131", strokeWidth: 4, roughness: 2 }),
  ];

  const result = polishSketch(scene, [group(["a", "b", "c"], ["match-style"])]);
  const stray = byId(result.elements, "c");

  assert.equal(stray.strokeColor, "#1e1e1e");
  assert.equal(stray.strokeWidth, 2);
  assert.equal(stray.roughness, 1);
  assert.deepEqual(result.changed, ["c"]);
});

test("a tombstoned or locked element is not part of anything", () => {
  const scene = [
    sketch({ id: "a", x: 0 }),
    sketch({ id: "b", x: 500 }),
    sketch({ id: "gone", x: 900, isDeleted: true }),
    // Pinned on purpose. A tidy-up is not a reason to override that.
    sketch({ id: "pinned", x: 900, locked: true }),
  ];

  const result = polishSketch(scene, [group(["a", "b", "gone", "pinned"], ["align-left"])]);

  assert.equal(byId(result.elements, "b").x, 0);
  assert.equal(result.elements[2], scene[2]);
  assert.equal(result.elements[3], scene[3]);
  assert.deepEqual(result.changed, ["b"]);
});

test("a group that changes nothing is not reported as a group that did", () => {
  const scene = [sketch({ id: "a", x: 0 }), sketch({ id: "b", x: 0 })];

  const result = polishSketch(scene, [
    group(["a", "b"], ["align-left"]),
    group([], ["align-left"]),
  ]);

  assert.deepEqual(result.changed, []);
  assert.equal(result.groups, 0);
  assert.equal(result.elements[0], scene[0]);
  assert.equal(result.elements[1], scene[1]);
});

test("no groups at all is a no-op, not an empty scene", () => {
  const scene = [sketch({ id: "a" }), sketch({ id: "b" })];
  const result = polishSketch(scene, []);

  assert.equal(result.elements.length, 2);
  assert.deepEqual(result.changed, []);
  assert.equal(result.groups, 0);
});
