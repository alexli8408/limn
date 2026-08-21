import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

/**
 * The paths that decide what gets written back onto the author's elements,
 * against a stubbed generateContent.
 *
 * Every case here is a way the model can hand back something that looks like a
 * correction and is not one. They matter more than the happy path because the
 * result lands on text the author typed, where a wrong edit is indistinguishable
 * from something they wrote themselves.
 */

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
  // rewrite.ts imports this enum as a value to set the thinking level, so a mock
  // without it fails at module load with an error that looks nothing like the
  // assertion that follows.
  ThinkingLevel: { MINIMAL: "MINIMAL", LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
}));

// rewrite.ts reaches these through @/lib/env, which validates at module load.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.GEMINI_API_KEY ??= "test-key";
// Pinned, not defaulted: the assertion on which model ran names it, and a
// developer with GEMINI_MODEL exported would otherwise fail the suite.
process.env.GEMINI_MODEL = "test-flash";
process.env.GEMINI_MODEL_PRO = "test-pro";

/** What the SDK hands back on a clean run. */
const ok = (payload: unknown) => ({
  text: JSON.stringify(payload),
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 60 },
});

const load = () => import("./rewrite");

beforeEach(() => {
  generateContent.mockReset();
});

test("only the text that actually changed comes back", async () => {
  const { rewriteText } = await load();
  generateContent.mockResolvedValue(
    ok({
      edits: [
        { id: "a", text: "the queue" },
        // Echoed back word for word. Passing this through would bump the
        // version of an element nothing happened to, so the board's history
        // would show an edit the author never made.
        { id: "b", text: "auth svc" },
      ],
      rationale: "one typo",
    }),
  );

  const { edits, meta } = await rewriteText({
    items: [
      { id: "a", text: "teh queue" },
      { id: "b", text: "auth svc" },
    ],
  });

  assert.deepEqual(edits, [{ id: "a", text: "the queue" }]);
  // Unchanged is the expected answer for most of a board, not a drop.
  assert.equal(meta.droppedItems, 0);
  assert.deepEqual(meta.warnings, []);
});

test("an id that was never sent is discarded", async () => {
  const { rewriteText } = await load();
  generateContent.mockResolvedValue(
    ok({
      edits: [
        { id: "a", text: "the queue" },
        // Nothing on the board answers to this, so applying it would either do
        // nothing or, worse, hit an element the model was never shown.
        { id: "ghost", text: "Invented Heading" },
      ],
      rationale: "two fixes",
    }),
  );

  const { edits, meta } = await rewriteText({ items: [{ id: "a", text: "teh queue" }] });

  assert.deepEqual(
    edits.map((edit) => edit.id),
    ["a"],
  );
  assert.equal(meta.droppedItems, 1);
  assert.match(meta.warnings.join(" "), /was not sent/);
});

test("an empty replacement is discarded rather than emptying the element", async () => {
  const { rewriteText } = await load();
  generateContent.mockResolvedValue(
    ok({
      edits: [
        { id: "a", text: "" },
        { id: "b", text: "   " },
        { id: "c", text: "Ingest" },
      ],
      rationale: "tidied",
    }),
  );

  const { edits, meta } = await rewriteText({
    items: [
      { id: "a", text: "notes" },
      { id: "b", text: "todo" },
      { id: "c", text: "ingset" },
    ],
  });

  assert.deepEqual(edits, [{ id: "c", text: "Ingest" }]);
  assert.equal(meta.droppedItems, 2);
  assert.match(meta.warnings.join(" "), /empty replacement/);
});

test("a label that came back as a sentence is refused", async () => {
  const { rewriteText } = await load();
  generateContent.mockResolvedValue(
    ok({
      edits: [{ id: "a", text: "The authentication service handles sign in for the whole app." }],
      rationale: "clarified",
    }),
  );

  const { edits, meta } = await rewriteText({ items: [{ id: "a", text: "auth svc" }] });

  assert.deepEqual(edits, []);
  assert.match(meta.warnings.join(" "), /rewritten rather than corrected/);
});

test("a second edit for the same id takes neither of them", async () => {
  const { rewriteText } = await load();
  generateContent.mockResolvedValue(
    ok({
      edits: [
        { id: "a", text: "the queue" },
        { id: "a", text: "The Queue" },
      ],
      rationale: "twice",
    }),
  );

  const { edits, meta } = await rewriteText({ items: [{ id: "a", text: "teh queue" }] });

  assert.deepEqual(edits, [{ id: "a", text: "the queue" }]);
  assert.equal(meta.droppedItems, 1);
  assert.match(meta.warnings.join(" "), /a second edit/);
});

test("a space added at the end of a label is not an edit, one inside it is", async () => {
  const { rewriteText } = await load();
  generateContent.mockResolvedValue(
    ok({
      edits: [
        { id: "a", text: "Ingest " },
        { id: "b", text: "queue depth" },
      ],
      rationale: "spacing",
    }),
  );

  const { edits } = await rewriteText({
    items: [
      { id: "a", text: "Ingest" },
      { id: "b", text: "queue  depth" },
    ],
  });

  assert.deepEqual(edits, [{ id: "b", text: "queue depth" }]);
});

test("one unusable id does not throw away the corrections beside it", async () => {
  const { rewriteText } = await load();
  generateContent.mockResolvedValue(
    ok({
      edits: [
        { id: "a", text: "the queue" },
        // Longer than any id the route accepts, which is what a model does when
        // it runs two ids together. It has to be refused one entry at a time:
        // failing the response over it would cost the user every real
        // correction in the same pass.
        { id: "x".repeat(400), text: "Ingest" },
      ],
      rationale: "one typo",
    }),
  );

  const { edits, meta } = await rewriteText({ items: [{ id: "a", text: "teh queue" }] });

  assert.deepEqual(edits, [{ id: "a", text: "the queue" }]);
  assert.equal(meta.droppedItems, 1);
  assert.match(meta.warnings.join(" "), /was not sent/);
  // The id is quoted back in the warning, which goes to the panel, so it is
  // clipped like every other quoted value rather than filling the screen.
  assert.ok(meta.warnings[0] && meta.warnings[0].length < 120, "an unclipped id reached a warning");
});

test("text echoed back unchanged does not block the correction that follows it", async () => {
  const { rewriteText } = await load();
  generateContent.mockResolvedValue(
    ok({
      edits: [
        // The model listed the item, then corrected it. Only the second entry
        // is an edit at all, so treating the echo as the one that claimed the
        // id would lose the fix and leave the typo on the board.
        { id: "a", text: "teh queue" },
        { id: "a", text: "the queue" },
      ],
      rationale: "one typo",
    }),
  );

  const { edits, meta } = await rewriteText({ items: [{ id: "a", text: "teh queue" }] });

  assert.deepEqual(edits, [{ id: "a", text: "the queue" }]);
  assert.equal(meta.droppedItems, 0);
});

test("a truncated response throws rather than writing back half a sentence", async () => {
  const { rewriteText } = await load();

  // Valid JSON, the last edit cut off mid-word. This is exactly the shape that
  // would otherwise be applied to the board as though it were finished.
  generateContent.mockResolvedValue({
    text: JSON.stringify({
      edits: [{ id: "a", text: "The ingest worker pulls from the que" }],
      rationale: "",
    }),
    candidates: [{ finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 16384 },
  });

  await assert.rejects(
    rewriteText({ items: [{ id: "a", text: "The ingest worker pulls from teh que" }] }),
    /more text on it than one pass can check/,
  );
});

test("a board with nothing written on it spends no Gemini call", async () => {
  const { rewriteText } = await load();

  const { edits, meta } = await rewriteText({
    items: [
      { id: "a", text: "" },
      { id: "b", text: "  " },
    ],
  });

  assert.deepEqual(edits, []);
  assert.equal(meta.attempts, 0);
  assert.equal(generateContent.mock.calls.length, 0, "asked Gemini about nothing");
});

test("the request constrains decoding, spends no thinking, and carries a deadline", async () => {
  const { rewriteText } = await load();
  generateContent.mockResolvedValue(ok({ edits: [], rationale: "already correct" }));

  await rewriteText({ items: [{ id: "a", text: "Ingest" }] });

  const [request] = generateContent.mock.calls[0] ?? [];
  assert.equal(request.model, "test-flash");
  assert.equal(request.config.thinkingConfig.thinkingLevel, "MINIMAL");
  assert.equal(request.config.responseMimeType, "application/json");
  assert.ok(request.config.responseSchema, "decoding ran unconstrained");
  assert.ok(request.config.abortSignal, "the attempt ran with no deadline of its own");
  // The text goes to the model verbatim; anything else is proofreading a
  // paraphrase of the board rather than the board.
  assert.match(request.contents[0].parts[0].text, /"id":"a","text":"Ingest"/);
});

test("a caller that hangs up gets a cancellation, not a Gemini error", async () => {
  const { rewriteText } = await load();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    rewriteText({ items: [{ id: "a", text: "teh queue" }], signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(generateContent.mock.calls.length, 0, "spent a call for a caller who left");
});
