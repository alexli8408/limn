import assert from "node:assert/strict";
import { test } from "vitest";
import { hasGeminiKey, liveCheck, loadEnv } from "./live-test";

/**
 * Hits the real Gemini API. Skipped unless a key is present, so CI and a fresh
 * clone stay green without credentials.
 *
 *   set -a && source .env && set +a && pnpm --filter @limn/web test
 *
 * Worth having as a test rather than a one-off script: model availability
 * changes underneath you. gemini-2.5-flash went from working to "no longer
 * available to new users" with no code change on our side, and the failure
 * surfaced as a 502 from the beautify route rather than anything diagnosable.
 * This turns that into a named assertion.
 */

loadEnv(import.meta.dirname);
const hasKey = hasGeminiKey();

test.skipIf(!hasKey)("generates a well-formed diagram from a prompt", async () => liveCheck(async () => {
  const { diagramFromPrompt } = await import("./gemini");
  const { layoutDiagram } = await import("./layout");

  const { diagram, meta } = await diagramFromPrompt({
    prompt:
      "How a realtime whiteboard syncs: user draws, the delta is broadcast, " +
      "peers merge it, and an elected writer saves a snapshot to Postgres.",
  });

  console.log(
    `  model=${meta.model} latency=${meta.latencyMs}ms ` +
      `out=${meta.outputTokens} nodes=${diagram.nodes.length} edges=${diagram.edges.length}`,
  );

  assert.ok(diagram.nodes.length >= 3, `only ${diagram.nodes.length} nodes`);
  assert.ok(diagram.edges.length >= 2, `only ${diagram.edges.length} edges`);
  assert.notEqual(diagram.layout, "preserve", "no sketch to preserve");

  // Every edge must reference a declared node. parseDiagram drops the rest, so
  // this failing means the repair step regressed.
  const ids = new Set(diagram.nodes.map((n) => n.id));
  for (const edge of diagram.edges) {
    assert.ok(ids.has(edge.from), `edge from unknown node ${edge.from}`);
    assert.ok(ids.has(edge.to), `edge to unknown node ${edge.to}`);
  }

  // And the whole thing has to survive layout without collapsing.
  const laid = layoutDiagram(diagram.nodes, diagram.edges, { direction: "TB" });
  assert.equal(laid.boxes.size, diagram.nodes.length, "a node lost its geometry");

  const boxes = [...laid.boxes.values()];
  const overlapping = boxes.some((a, i) =>
    boxes.some(
      (b, j) =>
        i < j &&
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y,
    ),
  );
  assert.ok(!overlapping, "layout produced overlapping nodes");
  // 60s: a Gemini 3.x call reasons before answering, and the retry path adds
  // two backoffs on top. vitest's 5s default fails long before the API would.
}), 60_000);

test.skipIf(!hasKey)("the configured models are actually reachable", async () => liveCheck(async () => {
  const key = process.env.GEMINI_API_KEY as string;
  const configured = [
    process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
    process.env.GEMINI_MODEL_PRO ?? "gemini-pro-latest",
  ];

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`,
  );
  assert.ok(response.ok, `model list failed: ${response.status}`);
  const body = (await response.json()) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
  };

  const usable = new Set(
    (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, "")),
  );

  for (const model of configured) {
    assert.ok(
      usable.has(model),
      `${model} is not available to this key. Available: ${[...usable].slice(0, 12).join(", ")}`,
    );
  }
}), 30_000);
