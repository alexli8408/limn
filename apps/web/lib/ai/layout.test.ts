import assert from "node:assert/strict";
import { test } from "vitest";
import { estimateNodeSize, layoutDiagram } from "./layout";
import { layouts, parseDiagram } from "./schema";
import type { DiagramEdge, DiagramNode } from "./schema";

/**
 * Layout is deterministic, so it can be asserted precisely rather than eyeballed.
 * These tests exist because layout is the part deliberately taken away from the
 * model: if it drifts, the argument for doing so stops holding.
 */

const node = (id: string, label = ""): DiagramNode => ({
  id,
  label,
  shape: "rectangle",
  emphasis: "normal",
  sourceIds: [],
});

const edge = (from: string, to: string): DiagramEdge => ({
  from,
  to,
  label: "",
  style: "solid",
  directed: true,
  sourceIds: [],
});

test("a chain lays out as one node per rank, in order", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => node(id));
  const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];

  const { boxes, rankCount } = layoutDiagram(nodes, edges, { direction: "TB" });

  assert.equal(rankCount, 4);
  const ys = ["a", "b", "c", "d"].map((id) => boxes.get(id)?.y ?? 0);
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i]! > ys[i - 1]!, `rank ${i} should sit below rank ${i - 1}`);
  }
});

test("siblings share a rank and do not overlap", () => {
  const nodes = [node("root"), node("x"), node("y"), node("z")];
  const edges = [edge("root", "x"), edge("root", "y"), edge("root", "z")];

  const { boxes } = layoutDiagram(nodes, edges);

  const siblings = ["x", "y", "z"].map((id) => boxes.get(id)!);
  const ys = new Set(siblings.map((b) => b.y));
  assert.equal(ys.size, 1, "all three should be on one baseline");

  const sorted = [...siblings].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.x - (sorted[i - 1]!.x + sorted[i - 1]!.width);
    assert.ok(gap > 0, `siblings overlap by ${-gap}px`);
  }
});

test("LR flows horizontally instead of vertically", () => {
  const nodes = [node("a"), node("b")];
  const edges = [edge("a", "b")];

  const lr = layoutDiagram(nodes, edges, { direction: "LR" });
  assert.ok(lr.boxes.get("b")!.x > lr.boxes.get("a")!.x);
  assert.equal(lr.boxes.get("a")!.y, lr.boxes.get("b")!.y);

  const tb = layoutDiagram(nodes, edges, { direction: "TB" });
  assert.ok(tb.boxes.get("b")!.y > tb.boxes.get("a")!.y);
});

test("a cycle terminates, and reports the edge it reversed", () => {
  const nodes = [node("a"), node("b"), node("c")];
  const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];

  const { boxes, reversedEdges } = layoutDiagram(nodes, edges);

  assert.equal(boxes.size, 3, "every node must still be placed");
  assert.equal(reversedEdges, 1, "exactly one back edge should have been reversed");
});

test("a self-loop is dropped by validation before layout ever sees it", () => {
  const { diagram, dropped } = parseDiagram({
    kind: "diagram",
    layout: "layered-tb",
    nodes: [{ id: "a", label: "A", shape: "rectangle", sourceIds: [] }],
    edges: [{ from: "a", to: "a", directed: true }],
    rationale: "",
  });
  assert.equal(diagram.edges.length, 0);
  assert.equal(dropped.edges, 1);
});

test("edges referencing an undeclared node are dropped, not rendered dangling", () => {
  const { diagram, dropped } = parseDiagram({
    kind: "diagram",
    layout: "layered-tb",
    nodes: [{ id: "a", label: "A", shape: "rectangle", sourceIds: [] }],
    edges: [
      { from: "a", to: "ghost", directed: true },
      { from: "nowhere", to: "a", directed: true },
    ],
    rationale: "",
  });
  assert.equal(diagram.edges.length, 0);
  assert.equal(dropped.edges, 2);
  assert.ok(dropped.reason.some((r) => r.includes("ghost")));
});

test("duplicate edges collapse and their labels merge onto the one arrow", () => {
  const { diagram } = parseDiagram({
    kind: "diagram",
    layout: "layered-tb",
    nodes: [
      { id: "a", label: "", shape: "rectangle", sourceIds: [] },
      { id: "b", label: "", shape: "rectangle", sourceIds: [] },
    ],
    edges: [
      { from: "a", to: "b", directed: true, label: "yes" },
      { from: "a", to: "b", directed: true, label: "yes" },
      { from: "a", to: "b", directed: true, label: "no" },
      { from: "b", to: "a", directed: true, label: "retry" },
    ],
    rationale: "",
  });

  // Both branches of a decision that rejoin the same node compile to two arrows
  // on identical coordinates, so keeping the label out of the key is the whole
  // point: one arrow gets drawn either way, and both labels have to reach it.
  assert.equal(diagram.edges.length, 2, "a->b is one arrow; b->a is a different pair");
  assert.equal(diagram.edges.find((e) => e.from === "a")?.label, "yes / no");
  assert.equal(diagram.edges.find((e) => e.from === "b")?.label, "retry", "reverse kept");
});

test("a repeated edge with one label does not gain a separator", () => {
  const { diagram } = parseDiagram({
    kind: "diagram",
    layout: "layered-tb",
    nodes: [
      { id: "a", label: "", shape: "rectangle", sourceIds: [] },
      { id: "b", label: "", shape: "rectangle", sourceIds: [] },
    ],
    edges: [
      { from: "a", to: "b", directed: true, label: "sends" },
      { from: "a", to: "b", directed: true, label: "" },
    ],
    rationale: "",
  });
  assert.equal(diagram.edges.length, 1);
  assert.equal(diagram.edges[0]?.label, "sends");
});

test('"grid" is no longer a layout the model can ask for', () => {
  // It was accepted and then mapped onto the top-to-bottom pass like anything
  // that is not layered-lr, so a sketch correctly read as a grid came back as a
  // single column. Better not to offer it than to offer it and ignore it.
  // @ts-expect-error the union must not contain it. If this line stops erroring,
  // the value is back and so is the silent conversion to a column.
  const gone: (typeof layouts)[number] = "grid";
  assert.ok(!(layouts as readonly string[]).includes(gone));
  assert.throws(
    () =>
      parseDiagram({
        kind: "diagram",
        layout: "grid",
        nodes: [],
        edges: [],
        rationale: "",
      }),
    Error,
    "a grid layout must be rejected, not silently laid out top to bottom",
  );
});

test("a response with no kind is treated as a drawing, not converted", () => {
  const { diagram } = parseDiagram({
    layout: "preserve",
    nodes: [{ id: "a", label: "A", shape: "rectangle", sourceIds: ["x"] }],
    edges: [],
    rationale: "",
  });

  // Failing closed: converting tombstones the sketch, so a truncated response
  // that lost its kind must not be allowed to do that on a default.
  assert.equal(diagram.kind, "drawing");
  assert.equal(diagram.nodes.length, 0);
});

test("disconnected components are all placed", () => {
  const nodes = [node("a"), node("b"), node("island")];
  const { boxes } = layoutDiagram(nodes, [edge("a", "b")]);
  assert.equal(boxes.size, 3);
  assert.ok(boxes.get("island"), "an unconnected node must still get coordinates");
});

test("an empty diagram produces an empty layout rather than throwing", () => {
  const { boxes, width, height } = layoutDiagram([], []);
  assert.equal(boxes.size, 0);
  assert.equal(width, 0);
  assert.equal(height, 0);
});

test("node size grows to fit its label", () => {
  const base = { width: 200, height: 90 };
  const small = estimateNodeSize("Hi", base);
  const long = estimateNodeSize(
    "Reconcile concurrent edits across every connected peer",
    base,
  );

  assert.deepEqual(small, base, "a short label should not shrink the default");
  assert.ok(
    long.height > base.height,
    `a wrapping label needs more height, got ${long.height}`,
  );
  assert.ok(long.width >= base.width);
});

test("layout is reproducible across runs", () => {
  const nodes = ["a", "b", "c", "d", "e"].map((id) => node(id, `Node ${id}`));
  const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d"), edge("d", "e")];

  const first = layoutDiagram(nodes, edges);
  const second = layoutDiagram(nodes, edges);

  for (const [id, box] of first.boxes) {
    assert.deepEqual(second.boxes.get(id), box, `node ${id} moved between runs`);
  }
});

test("barycentre ordering reduces crossings on a bipartite tangle", () => {
  // Deliberately declared in an order that crosses if left alone.
  const nodes = [node("a1"), node("a2"), node("a3"), node("b1"), node("b2"), node("b3")];
  const edges = [edge("a1", "b3"), edge("a2", "b2"), edge("a3", "b1")];

  const { boxes } = layoutDiagram(nodes, edges);

  const crossings = countCrossings(edges, boxes);
  assert.equal(crossings, 0, `expected the ordering pass to untangle this, got ${crossings}`);
});

function countCrossings(
  edges: readonly DiagramEdge[],
  boxes: Map<string, { x: number; width: number }>,
): number {
  const centre = (id: string) => {
    const box = boxes.get(id);
    return box ? box.x + box.width / 2 : 0;
  };
  let total = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!;
      const b = edges[j]!;
      const topOrder = centre(a.from) - centre(b.from);
      const bottomOrder = centre(a.to) - centre(b.to);
      if (topOrder * bottomOrder < 0) total++;
    }
  }
  return total;
}
