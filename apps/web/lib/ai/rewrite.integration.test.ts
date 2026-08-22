import assert from "node:assert/strict";
import { test } from "vitest";
import { hasGeminiKey, liveCheck, loadEnv } from "./live-test";

/**
 * Fix the writing, against the real API.
 *
 * This feature shipped without ever having run once. Everything under it is
 * mocked in rewrite.test.ts, which proves the parsing and the dropping rules and
 * nothing about whether the model does the job it is asked to do.
 *
 * The job is unusually narrow and the failure mode is the interesting part. It
 * may fix mechanical errors and nothing else, because the result lands on the
 * author's own board where they cannot see what changed. A better sentence they
 * did not write is a bug, so this asserts what must survive as hard as it
 * asserts what must be corrected.
 *
 * Skipped without a key, like the other live tests.
 */

loadEnv(import.meta.dirname);
const hasKey = hasGeminiKey();

/** Deliberate stylings that a proofreader "improves" and must not. */
const KEEP = [
  { id: "k1", text: "AUTH SVC" },
  { id: "k2", text: "db" },
  { id: "k3", text: "retry w/ backoff" },
];

/** Real slips, each unambiguous. */
const FIX = [
  { id: "f1", text: "Databse" },
  { id: "f2", text: "conection pool" },
  { id: "f3", text: "recieve  the  request" },
];

test.skipIf(!hasKey)(
  "corrects the slips and leaves deliberate wording alone",
  async () =>
    liveCheck(async () => {
      const { rewriteText } = await import("./rewrite");

      const { edits, meta } = await rewriteText({ items: [...KEEP, ...FIX] });
      const byId = new Map(edits.map((edit) => [edit.id, edit.text]));

      console.log(`  model=${meta.model} latency=${meta.latencyMs}ms edits=${edits.length}`);
      for (const edit of edits) {
        const before = [...KEEP, ...FIX].find((item) => item.id === edit.id)?.text;
        console.log(`    ${JSON.stringify(before)} -> ${JSON.stringify(edit.text)}`);
      }

      // Never an id it was not given, and never empty text. parseRewrite drops
      // both; this catches the day it stops.
      const known = new Set([...KEEP, ...FIX].map((item) => item.id));
      for (const edit of edits) {
        assert.ok(known.has(edit.id), `invented id ${edit.id}`);
        assert.ok(edit.text.trim().length > 0, `empty text for ${edit.id}`);
      }

      // The slips have to be caught, or the feature does nothing.
      for (const item of FIX) {
        assert.ok(byId.has(item.id), `left ${JSON.stringify(item.text)} uncorrected`);
      }
      assert.match(byId.get("f1") ?? "", /database/i, "Databse should become Database");
      assert.match(byId.get("f2") ?? "", /connection/i, "conection should become connection");

      /**
       * And the stylings have to survive.
       *
       * This is the half that makes the feature safe to run over someone's
       * board. An all-caps label, a lowercase one and a shorthand are choices,
       * and "correcting" them into Auth Service, Db and "retry with backoff" is
       * exactly how a proofreader ruins a diagram.
       */
      for (const item of KEEP) {
        assert.ok(
          !byId.has(item.id),
          `rewrote ${JSON.stringify(item.text)} as ${JSON.stringify(byId.get(item.id))}, ` +
            `which was a deliberate styling and not a mistake`,
        );
      }
    }),
  120_000,
);
