import assert from "node:assert/strict";
import { test } from "vitest";
import { bbox, fitLine } from "@limn/shapes";
import type { SyncElement } from "@limn/protocol";
import { polishSketch, visualBox } from "./polish";
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

/**
 * An open arc of `degrees` on a chord of `chord` px, drawn left to right and
 * anchored on its first point the way Excalidraw stores a stroke.
 *
 * Real arcs, because straighten is judged on a measurement of the actual points
 * and a hand-written list of plausible-looking ones proves nothing about where
 * that measurement lands.
 */
function drawnArc(degrees: number, chord = 186, samples = 40): [number, number][] {
  const sweep = (degrees * Math.PI) / 180;
  const radius = chord / (2 * Math.sin(sweep / 2));
  const raw: [number, number][] = [];
  for (let i = 0; i < samples; i++) {
    const t = -sweep / 2 + (i / (samples - 1)) * sweep;
    raw.push([radius * Math.sin(t), radius * Math.cos(t) - radius * Math.cos(sweep / 2)]);
  }
  const first = raw[0] as [number, number];
  return raw.map(([x, y]) => [x - first[0], y - first[1]] as [number, number]);
}

/**
 * The same stroke with a hand's worth of shake on it, re-anchored on its first
 * point. Deterministic for the same reason drawnCircle's wobble is.
 */
function shaken(points: [number, number][], amount: number): [number, number][] {
  const jitter = (i: number) => (((i * 7919) % 9) / 4 - 1) * amount;
  const raw = points.map(([x, y], i) => [x + jitter(i), y + jitter(i + 3)] as [number, number]);
  const first = raw[0] as [number, number];
  return raw.map(([x, y]) => [x - first[0], y - first[1]] as [number, number]);
}

/** What straighten measures a stroke by: mean distance off its own best fit, over its diagonal. */
function fitError(points: [number, number][]): number {
  const extent = bbox(points);
  return fitLine(points).residual / Math.hypot(extent.width, extent.height);
}

/** The stroke as an element, sized off its own points the way the editor does. */
function strokeOf(id: string, x: number, y: number, points: [number, number][]): SyncElement {
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  return sketch({
    id,
    type: "freedraw",
    x,
    y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points,
  });
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

test("a stroke drawn right to left aligns by its ink, not its anchor", () => {
  /**
   * Excalidraw stores x,y as the position of points[0], not as the top-left of
   * the bounding box, and points may be negative. A stroke drawn right to left
   * therefore has its anchor at the RIGHT end and negative x offsets, so its ink
   * sits between x - width and x.
   *
   * Reading x as the box corner puts that stroke a full width away from where it
   * actually is, and alignment then moves it to the wrong place: the user sees
   * the one stroke they drew backwards fly off on its own.
   */
  const existing = [
    sketch({ id: "box", type: "rectangle", x: 400, y: 0, width: 100, height: 60 }),
    sketch({
      id: "backwards",
      type: "freedraw",
      // Anchor on the right, ink running left to x = 300.
      x: 400,
      y: 200,
      width: 100,
      height: 0,
      points: [
        [0, 0],
        [-100, 0],
      ],
    }),
  ];

  const { elements } = polishSketch(existing, [group(["box", "backwards"], ["align-left"])]);
  const stroke = elements.find((el) => String(el.id) === "backwards");
  assert.ok(stroke);

  // Its leftmost ink must end up on the shared edge at x = 300 (the box's left
  // is 400, the stroke's ink starts at 300, so 300 is the shared left).
  const xs = (stroke.points as [number, number][]).map(([dx]) => Number(stroke.x) + dx);
  const inkLeft = Math.min(...xs);
  const box = elements.find((el) => String(el.id) === "box");
  assert.ok(box);

  assert.equal(
    inkLeft,
    Number(box.x),
    `the stroke's ink starts at ${inkLeft}, the box at ${Number(box.x)}`,
  );
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

test("a resize about the centre leaves the label where it is", () => {
  /**
   * The centre does not move, so the label sitting on it must not either.
   *
   * Resize kept its member centred by translating it, and a translation used to
   * drag the bound text along by the same delta. Both are right on their own and
   * wrong together: the box shrinks 100px and its label slides 50px, so half of
   * it hangs outside the box it names.
   */
  const scene = [
    sketch({
      id: "boxA",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      boundElements: [{ id: "label", type: "text" }],
    }),
    sketch({ id: "label", type: "text", x: 80, y: 40, width: 40, height: 20, containerId: "boxA" }),
    sketch({ id: "boxB", x: 400, y: 0, width: 100, height: 60 }),
    sketch({ id: "boxC", x: 700, y: 0, width: 100, height: 60 }),
  ];

  const result = polishSketch(scene, [group(["boxA", "boxB", "boxC"], ["equalize-size"])]);
  const boxA = byId(result.elements, "boxA");

  assert.equal(boxA.width, 100);
  assert.equal(boxA.height, 60);
  assert.equal(boxA.x, 50, "still centred where it was");
  assert.equal(boxA.y, 20);

  const label = byId(result.elements, "label");
  assert.equal(label.x, 80, `the label moved to ${Number(label.x)}, outside its own box`);
  assert.equal(label.y, 40);
  // Nothing about the label changed, so it is not resent either.
  assert.equal(result.elements[1], scene[1]);
  assert.ok(!result.changed.includes("label"));
});

test("a resized arrow leaves its own label on the midpoint too", () => {
  /**
   * The other half of the same rule. A stroke is resized by rewriting its
   * points, not by writing width and height, so it goes down a different path
   * and needs the same answer: an arrow scaled about its middle keeps that
   * middle, and the label Excalidraw parks there must not slide off one end.
   */
  const arrow = (id: string, y: number, length: number, extra: Record<string, unknown> = {}) =>
    sketch({
      id,
      type: "arrow",
      x: 0,
      y,
      width: length,
      height: 0,
      points: [[0, 0], [length, 0]],
      ...extra,
    });

  const scene = [
    arrow("long", 0, 200, { boundElements: [{ id: "label", type: "text" }] }),
    sketch({ id: "label", type: "text", x: 90, y: -10, width: 20, height: 20, containerId: "long" }),
    arrow("a", 300, 100),
    arrow("b", 400, 100),
  ];

  const result = polishSketch(scene, [group(["long", "label", "a", "b"], ["equalize-size"])]);
  const long = byId(result.elements, "long");

  assert.equal(long.width, 100, "the median length of the three");
  assert.equal(long.x, 50, "shortened from both ends, so the middle is still 100");

  const label = byId(result.elements, "label");
  assert.equal(label.x, 90, `the label moved to ${Number(label.x)}, off the arrow it names`);
  assert.equal(result.elements[1], scene[1]);
  assert.deepEqual(result.changed, ["long"]);
});

test("straighten keeps an arch and still flattens a lazy line", () => {
  /**
   * A 137 degree arch on a 186px chord has a 63px sagitta. It is a rainbow, or a
   * smile, and there is no reading of it as a stroke aiming at a segment.
   *
   * The old guard let it through: it compared the fit error against 0.12, a
   * figure taken from a full circle, and a circle never reaches that check
   * because a closed stroke is turned away first. Open arcs score far lower, so
   * everything short of about 175 degrees came back as two points.
   */
  const arch = drawnArc(137);
  const lazy = drawnArc(30);
  const scene = [strokeOf("arch", 100, 400, arch), strokeOf("lazy", 600, 400, lazy)];

  const result = polishSketch(scene, [
    group(["arch"], ["straighten"]),
    group(["lazy"], ["straighten"]),
  ]);

  assert.equal(result.elements[0], scene[0], "the arch is left as drawn, not flattened");
  // 12px of sag over 186px is a line someone did not take care over, which is
  // exactly what straighten is for.
  assert.equal((byId(result.elements, "lazy").points as unknown[]).length, 2);
  assert.deepEqual(result.changed, ["lazy"]);
});

test("straighten judges the shape of the error, not the size of it", () => {
  /**
   * A wide 90 degree bow and a 40px stroke drawn with a shaky hand, in one
   * group, and the BOW is the one further off its own best fit. So no threshold
   * on that distance alone can keep the bow and flatten the shake, whichever way
   * round it is set: the two are in the wrong order for it.
   *
   * What separates them is where the error goes. The bow leaves its fit, stays
   * on one side the whole way across, and comes back. The shake crosses over
   * four times.
   */
  const bow = drawnArc(90);
  const shake: [number, number][] = [[0, 0], [10, 3], [20, -2], [30, 4], [40, 0]];
  assert.ok(
    fitError(bow) > fitError(shake),
    `the premise is gone: bow ${fitError(bow).toFixed(4)}, shake ${fitError(shake).toFixed(4)}`,
  );

  const scene = [strokeOf("bow", 100, 400, bow), strokeOf("shake", 600, 400, shake)];
  const result = polishSketch(scene, [group(["bow", "shake"], ["straighten"])]);

  assert.equal(result.elements[0], scene[0], "the bow is left as drawn");
  const points = byId(result.elements, "shake").points as [number, number][];
  assert.equal(points.length, 2);
  assert.ok(Math.abs(points[1]?.[1] ?? 99) <= 2, "the wobble does not survive");
  assert.deepEqual(result.changed, ["shake"]);
});

test("straighten keeps a bow that was drawn with a shaky hand", () => {
  /**
   * Nobody draws a clean arc with a mouse. The jitter where a shaky bow wanders
   * back and forth across its own best fit counted as four swaps of side, which
   * is what wobble looks like, so the bow was flattened.
   *
   * Offsets under a fifth of the widest one are treated as sitting ON the line
   * rather than to either side of it, and that is enough to leave the swaps to
   * the two the bow itself makes.
   */
  const scene = [strokeOf("bow", 0, 0, shaken(drawnArc(90), 10))];

  const result = polishSketch(scene, [group(["bow"], ["straighten"])]);

  assert.equal(result.elements[0], scene[0], "the bow is left as drawn");
  assert.deepEqual(result.changed, []);
  assert.equal(result.groups, 0);
});

test("align-top uses the edge a rotated element actually shows", () => {
  /**
   * x, y, width and height describe an element before it is turned, and
   * Excalidraw turns it about the centre of that box. A 200 by 40 bar at 45
   * degrees therefore covers a 170 square whose top is 65px above the y it
   * reports.
   *
   * Reading the untilted y as the top put every member on y = 100 and left the
   * bar sticking 65px out above the line they were all supposedly sharing. Snap
   * writes an angle onto anything more than 8 degrees off axis, so a tilted
   * member is ordinary, not exotic.
   */
  const scene = [
    sketch({ id: "box", x: 0, y: 100, width: 100, height: 60 }),
    sketch({ id: "bar", x: 400, y: 100, width: 200, height: 40, angle: Math.PI / 4 }),
  ];

  const result = polishSketch(scene, [group(["box", "bar"], ["align-top"])]);
  const box = byId(result.elements, "box");
  const bar = byId(result.elements, "bar");

  const top = (el: SyncElement): number => {
    const seen = visualBox(el as unknown as Record<string, unknown>);
    assert.ok(seen);
    return seen.y;
  };

  assert.ok(Math.abs(top(box) - top(bar)) <= 1, `tops are ${top(box)} and ${top(bar)}`);
  // The bar's visible top was already the highest, so it is the one that stays
  // and the plain box is the one that rises to meet it.
  assert.equal(bar.y, 100);
  assert.equal(box.y, 35);
});

test("equalize-size sizes a rotated member in its own frame and keeps it centred", () => {
  /**
   * The tilt decides where a member sits, not how big it is. width and height
   * are the size before the turn, so that is the frame the median has to be
   * taken in: sizing the bar to the 170 square it covers would have the next run
   * measure 148 and size it again, and the op would never settle.
   */
  const scene = [
    sketch({ id: "bar", x: 400, y: 100, width: 200, height: 40, angle: Math.PI / 4 }),
    sketch({ id: "boxB", x: 0, y: 0, width: 100, height: 60 }),
    sketch({ id: "boxC", x: 900, y: 0, width: 100, height: 60 }),
  ];

  const result = polishSketch(scene, [group(["bar", "boxB", "boxC"], ["equalize-size"])]);
  const bar = byId(result.elements, "bar");

  assert.equal(bar.width, 100);
  assert.equal(bar.height, 60);
  assert.equal(bar.angle, Math.PI / 4, "the tilt is not a size and is not touched");
  // Resized about the centre it was turned about, so it does not appear to swing.
  assert.equal(Number(bar.x) + Number(bar.width) / 2, 500);
  assert.equal(Number(bar.y) + Number(bar.height) / 2, 120);
});

test("visualBox reports the ink of a backwards stroke and the cover of a tilted box", () => {
  // Exported so BoardCanvas can describe the same boxes to Gemini that get
  // edited here. Two copies of this drift, and then the model is reasoning about
  // one set of edges while polish moves another.
  const backwards = visualBox({
    x: 400,
    y: 200,
    width: 100,
    height: 0,
    points: [
      [0, 0],
      [-100, 0],
    ],
  });
  assert.ok(backwards);
  assert.equal(backwards.x, 300, "a right-to-left stroke is anchored at its right end");
  assert.equal(backwards.width, 100);

  const tilted = visualBox({
    type: "rectangle",
    x: 400,
    y: 100,
    width: 200,
    height: 40,
    angle: Math.PI / 4,
  });
  assert.ok(tilted);
  assert.equal(Math.round(tilted.width), 170);
  assert.equal(Math.round(tilted.height), 170);
  assert.equal(Math.round(tilted.x), 415, "still centred on 500");
  assert.equal(Math.round(tilted.y), 35);

  assert.equal(visualBox({ x: "nope", y: 0, width: 10, height: 10 }), null);
});

test("visualBox measures an ellipse and a diamond by their own outline", () => {
  /**
   * Only a rectangle reaches a corner, and only a corner is both turned sides
   * added together. An ellipse is widest where its tangent stands vertical,
   * which is a hypotenuse, and a diamond's vertices are the midpoints of its
   * box's edges, so one of them is the widest point and there is nothing to add
   * to it. Excalidraw carries all three formulas for the same reason.
   *
   * Measuring the lot as rectangles gave every one of these 170, which reads a
   * tilted ellipse as 13px wider on each side than it draws.
   */
  const turned = (type: string) =>
    visualBox({ type, x: 400, y: 100, width: 200, height: 40, angle: Math.PI / 4 });

  const ellipse = turned("ellipse");
  assert.ok(ellipse);
  assert.equal(Math.round(ellipse.width), 144);
  assert.equal(Math.round(ellipse.height), 144);

  const diamond = turned("diamond");
  assert.ok(diamond);
  assert.equal(Math.round(diamond.width), 141);
  assert.equal(Math.round(diamond.height), 141);

  // All three still turn about the same centre, which is the part resize relies on.
  for (const box of [ellipse, diamond, turned("rectangle")]) {
    assert.ok(box);
    assert.equal(Math.round(box.x + box.width / 2), 500);
    assert.equal(Math.round(box.y + box.height / 2), 120);
  }
});

test("visualBox turns a stroke's ink, not the box around it", () => {
  /**
   * An L drawn in a 100 square and then turned 45 degrees is a narrow diagonal
   * chevron, 71 wide and 141 tall. Turning the BOX instead hands back a 141
   * square, because a box has corners where this stroke has nothing at all, and
   * alignment then flushes 35px of empty canvas against the shared edge.
   */
  const chevron = visualBox({
    type: "freedraw",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: Math.PI / 4,
    points: [
      [0, 0],
      [100, 0],
      [100, 100],
    ],
  });

  assert.ok(chevron);
  assert.equal(Math.round(chevron.width), 71);
  assert.equal(Math.round(chevron.height), 141);
  assert.equal(Math.round(chevron.x), 50);
  assert.equal(Math.round(chevron.y), -21);
});

test("align-top flushes a tilted ellipse by its outline, not by its corners", () => {
  /**
   * Same miss as the bar above, one shape along: the ellipse's visible top is 48,
   * not the 35 a rectangle of the same box would show. Reading every tilted
   * member as a rectangle left the plain box 13px high of the edge it was
   * supposed to be sharing.
   */
  const turn = Math.PI / 4;
  const scene = [
    sketch({ id: "box", x: 0, y: 100, width: 100, height: 60 }),
    sketch({ id: "leaf", type: "ellipse", x: 400, y: 100, width: 200, height: 40, angle: turn }),
  ];

  const result = polishSketch(scene, [group(["box", "leaf"], ["align-top"])]);

  assert.equal(byId(result.elements, "leaf").y, 100, "the highest member is the one that stays");
  assert.equal(byId(result.elements, "box").y, 48);
});
