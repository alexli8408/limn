import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

/**
 * The OCR paths that decide whether a word lands in the right place, is quietly
 * invented, or is quietly lost, against a stubbed generateContent.
 *
 * Truncation is the one that matters most, because it is the failure that looks
 * like a success: partial JSON parses, the short list validates, and the board
 * comes back carrying the top half of its labels with nothing to say the rest
 * were ever read.
 */

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
  // ocr.ts imports this enum as a value to set the thinking level, so a mock
  // without it fails at module load with an error that looks nothing like the
  // assertion that follows.
  ThinkingLevel: { MINIMAL: "MINIMAL", LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
}));

// ocr.ts reaches these through @/lib/env, which validates at module load.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.GEMINI_API_KEY ??= "test-key";
process.env.GEMINI_MODEL = "test-flash";
process.env.GEMINI_MODEL_PRO = "test-pro";

/** What the SDK hands back on a clean run. */
const ok = (payload: unknown) => ({
  text: JSON.stringify(payload),
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120 },
});

const load = () => import("./ocr");

const IMAGE = "a".repeat(128);

beforeEach(() => {
  generateContent.mockReset();
});

test("boxes come back inside the image, whatever the model rounded to", async () => {
  const { readBoardText } = await load();
  generateContent.mockResolvedValue(
    ok({
      text: [
        { text: "auth service", x: 0.1, y: 0.2, width: 0.25, height: 0.05, confidence: 0.9 },
        // Rounded past the right edge. Trimming rather than dropping: the
        // reading is fine, only the last decimal place is wrong.
        { text: "queue", x: 0.9, y: 0.72, width: 0.14, height: 1.02, confidence: 0.4 },
      ],
      rationale: "two labels",
    }),
  );

  const { text } = await readBoardText({ imageBase64: IMAGE });

  assert.equal(text.length, 2);
  for (const item of text) {
    const { x, y, width, height } = item.box;
    for (const [name, value] of Object.entries({ x, y, width, height })) {
      assert.ok(value >= 0 && value <= 1, `${name} was ${value}, outside the image`);
    }
    assert.ok(x + width <= 1, `"${item.text}" runs off the right edge`);
    assert.ok(y + height <= 1, `"${item.text}" runs off the bottom edge`);
    assert.ok(item.confidence >= 0 && item.confidence <= 1);
  }
  assert.equal(text[0]?.text, "auth service");
});

test("a photo with no writing on it yields no text rather than invented text", async () => {
  const { readBoardText } = await load();
  generateContent.mockResolvedValue(
    ok({ text: [], rationale: "The board is wiped clean; there is nothing written on it." }),
  );

  const result = await readBoardText({ imageBase64: IMAGE });

  assert.deepEqual(result.text, []);
  assert.equal(result.meta.droppedItems, 0);
  // The sentence is the whole point of an empty answer: it is what tells the
  // user the photo was read and found blank, rather than that OCR broke.
  assert.match(result.meta.rationale, /nothing written/);
});

test("a truncated response throws rather than returning the words it did read", async () => {
  const { readBoardText } = await load();

  // Valid JSON, most of the board missing. This is exactly the shape that would
  // otherwise be applied as though it were the whole answer.
  generateContent.mockResolvedValue({
    text: JSON.stringify({
      text: [{ text: "ingest", x: 0.05, y: 0.05, width: 0.2, height: 0.06, confidence: 0.9 }],
      rationale: "",
    }),
    candidates: [{ finishReason: "MAX_TOKENS" }],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 16384 },
  });

  await assert.rejects(
    readBoardText({ imageBase64: IMAGE }),
    /more writing on it than one pass can read/,
  );
});

test("a response in Gemini's 0 to 1000 box convention is rescaled, not discarded", async () => {
  const { readBoardText } = await load();
  generateContent.mockResolvedValue(
    ok({
      text: [
        { text: "start", x: 40, y: 60, width: 180, height: 55, confidence: 0.8 },
        { text: "done", x: 620, y: 700, width: 150, height: 50, confidence: 0.8 },
      ],
      rationale: "two labels",
    }),
  );

  const { text, meta } = await readBoardText({ imageBase64: IMAGE });

  assert.equal(text.length, 2, "a whole response in the wrong unit was thrown away");
  assert.deepEqual(text[0]?.box, { x: 0.04, y: 0.06, width: 0.18, height: 0.055 });
  assert.match(meta.warnings.join(" "), /rescaled/);
});

test("a box the model put outside the photo is dropped, not pinned to the edge", async () => {
  const { readBoardText } = await load();
  generateContent.mockResolvedValue(
    ok({
      text: [
        { text: "keep", x: 0.3, y: 0.3, width: 0.2, height: 0.05, confidence: 0.9 },
        // Far enough out to be a wrong reading of position rather than rounding.
        // Clamping would stack it on the board's edge where the author has to
        // hunt for it; dropping it leaves the trace as it was.
        { text: "nowhere", x: 1.8, y: 0.4, width: 0.2, height: 0.05, confidence: 0.5 },
      ],
      rationale: "one label",
    }),
  );

  const { text, meta } = await readBoardText({ imageBase64: IMAGE });

  assert.deepEqual(
    text.map((item) => item.text),
    ["keep"],
  );
  assert.equal(meta.droppedItems, 1);
  assert.match(meta.warnings.join(" "), /outside the photo/);
});

test("the fast path spends no thinking tokens and constrains decoding", async () => {
  const { readBoardText } = await load();
  generateContent.mockResolvedValue(ok({ text: [], rationale: "blank" }));

  await readBoardText({ imageBase64: IMAGE, mimeType: "image/jpeg" });

  const [request] = generateContent.mock.calls[0] ?? [];
  assert.equal(request.model, "test-flash");
  assert.equal(request.config.thinkingConfig.thinkingLevel, "MINIMAL");
  assert.equal(request.config.responseMimeType, "application/json");
  assert.ok(request.config.responseSchema, "decoding ran unconstrained");
  assert.ok(request.config.abortSignal, "the attempt ran with no deadline of its own");
  assert.equal(request.contents[0].parts[0].inlineData.mimeType, "image/jpeg");
});
