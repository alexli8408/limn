import assert from "node:assert/strict";
import { beforeEach, afterEach, test, vi } from "vitest";
import { parseDiagram } from "./schema";

/**
 * The failure paths, against a stubbed generateContent.
 *
 * These are the cases the live tests cannot reach: the real API answers STOP on
 * anything small enough to send from a test, and burning a daily quota to see a
 * retry is not a trade worth making. Truncation is the one that matters most,
 * because it is the only failure here that used to succeed: partial JSON parses,
 * parseDiagram accepts the short node list, and the compiler tombstones every
 * source element it named while the rest of the board is dropped.
 */

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

// Spied rather than replaced: the assertion is that truncation never reaches it,
// which only means anything if the real one still runs on the happy path.
vi.mock("./schema", async () => {
  const actual = await vi.importActual<typeof import("./schema")>("./schema");
  return { ...actual, parseDiagram: vi.fn(actual.parseDiagram) };
});

// gemini.ts reaches these through @/lib/env, which validates at module load.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.GEMINI_API_KEY ??= "test-key";
// Pinned, not defaulted: the fallback assertion below names them, and a
// developer with GEMINI_MODEL exported would otherwise fail the suite.
process.env.GEMINI_MODEL = "test-flash";
process.env.GEMINI_MODEL_PRO = "test-pro";

const diagram = {
  kind: "diagram",
  layout: "layered-tb",
  rationale: "",
  notes: [],
  nodes: [
    { id: "n1", label: "one", shape: "rectangle", emphasis: "normal", sourceIds: [] },
    { id: "n2", label: "two", shape: "rectangle", emphasis: "normal", sourceIds: [] },
  ],
  edges: [{ from: "n1", to: "n2", label: "", directed: true }],
};

/** What the SDK hands back on a clean run. */
const ok = () => ({
  text: JSON.stringify(diagram),
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
});

/** A 503, which generate() treats as worth riding out. */
const transient = () => Object.assign(new Error("503 Service Unavailable"), { status: 503 });

const load = () => import("./gemini");

beforeEach(() => {
  generateContent.mockReset();
  vi.mocked(parseDiagram).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a truncated response throws before anything can be parsed", async () => {
  const { diagramFromPrompt } = await load();

  // Valid JSON, one node short. This is exactly the shape that used to be
  // applied to the board as though it were the whole answer.
  generateContent.mockResolvedValue({
    text: JSON.stringify({ ...diagram, nodes: diagram.nodes.slice(0, 1), edges: [] }),
    candidates: [{ finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 16384 },
  });

  await assert.rejects(
    diagramFromPrompt({ prompt: "a flow with several steps" }),
    /too large to redraw in one pass/,
  );
  assert.equal(vi.mocked(parseDiagram).mock.calls.length, 0, "parsed a truncated response");
});

test("a blocked prompt says so instead of reporting an empty response", async () => {
  const { diagramFromPrompt } = await load();
  generateContent.mockResolvedValue({
    text: "",
    candidates: [],
    promptFeedback: { blockReason: "SAFETY" },
  });

  await assert.rejects(diagramFromPrompt({ prompt: "something refused" }), (error: Error) => {
    assert.match(error.message, /SAFETY/);
    assert.doesNotMatch(error.message, /empty response/);
    return true;
  });
});

test("latency covers the whole retry chain, not the attempt that worked", async () => {
  vi.useFakeTimers();
  const { diagramFromPrompt } = await load();
  generateContent
    .mockRejectedValueOnce(transient())
    .mockRejectedValueOnce(transient())
    .mockResolvedValueOnce(ok());

  const pending = diagramFromPrompt({ prompt: "a flow" });
  // 700ms then 1400ms of backoff, which the old timing threw away by starting
  // the clock again inside each attempt.
  await vi.advanceTimersByTimeAsync(5_000);
  const { meta } = await pending;

  assert.equal(meta.attempts, 3);
  assert.equal(generateContent.mock.calls.length, 3);
  assert.ok(meta.latencyMs >= 2_100, `latency was ${meta.latencyMs}ms, so a retry went unrecorded`);
  assert.equal(meta.fellBack, false);
});

test("a retry chain stops rather than outrunning the route's maxDuration", async () => {
  vi.useFakeTimers();
  const { diagramFromPrompt } = await load();
  generateContent.mockRejectedValue(transient());

  // Wrapped before the clock moves, so the rejection is never briefly unhandled.
  const settled = assert.rejects(diagramFromPrompt({ prompt: "a flow" }));
  await vi.advanceTimersByTimeAsync(5_000);
  await settled;
  // Three calls, not the four the old `attempt < 3` allowed.
  assert.equal(generateContent.mock.calls.length, 3);
  for (const [request] of generateContent.mock.calls) {
    assert.ok(request.config.abortSignal, "an attempt ran with no deadline of its own");
  }
});

test("a fallback to flash keeps counting the attempts it already spent", async () => {
  vi.useFakeTimers();
  const { diagramFromPrompt } = await load();
  const busy = () => Object.assign(new Error("429 quota"), { status: 429 });
  // Retries come first, so the fallback only fires once pro is out of them.
  generateContent
    .mockRejectedValueOnce(busy())
    .mockRejectedValueOnce(busy())
    .mockRejectedValueOnce(busy())
    .mockResolvedValueOnce(ok());

  const pending = diagramFromPrompt({ prompt: "a flow", pro: true });
  await vi.advanceTimersByTimeAsync(5_000);
  const { meta } = await pending;

  assert.equal(meta.fellBack, true);
  assert.equal(meta.attempts, 4, "the counter restarted with the fallback");
  assert.equal(meta.model, "test-flash", "meta.model must name the model that answered");
});
