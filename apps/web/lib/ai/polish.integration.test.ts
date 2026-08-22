import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";
import type { SyncElement } from "@limn/protocol";
import { hasGeminiKey, liveCheck, loadEnv } from "./live-test";

/**
 * The end to end case Beautify exists for, against the real API.
 *
 * Everything else about polishing is unit tested against groups written by
 * hand, which proves the compiler does what it is told and nothing about
 * whether the model tells it anything sensible. This is the half that can only
 * be measured by asking.
 *
 * The fixture is a house, a sun and a ground line: a picture, not a diagram.
 * That is precisely what the feature used to refuse, so a regression to the old
 * behaviour shows up here as `kind` coming back "diagram" or as an empty group
 * list, rather than as a silently worse product.
 *
 * Skipped without a key, like the other live tests. See live-test.ts.
 */

loadEnv(import.meta.dirname);
const hasKey = hasGeminiKey();

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const elements = JSON.parse(
  readFileSync(resolve(FIXTURES, "hand-drawn.json"), "utf8"),
) as SyncElement[];
const image = readFileSync(resolve(FIXTURES, "hand-drawn.png")).toString("base64");

test.skipIf(!hasKey)("groups a drawing and tidies it without losing a stroke", async () =>
  liveCheck(async () => {
    const { refineSketch } = await import("./gemini");
    const { polishSketch } = await import("./polish");

    const { diagram, meta } = await refineSketch({
      elements: elements.map((el) => ({
        id: String(el.id),
        type: String(el.type),
        x: Number(el.x),
        y: Number(el.y),
        width: Number(el.width),
        height: Number(el.height),
      })),
      imageBase64: image,
    });

    console.log(
      `  model=${meta.model} latency=${meta.latencyMs}ms kind=${diagram.kind} ` +
        `groups=${diagram.groups.length}`,
    );
    for (const group of diagram.groups) {
      console.log(`    "${group.label}": ${group.ids.length} strokes, [${group.ops.join(", ")}]`);
    }

    // The whole point. A house is not a flowchart, and reading it as one is the
    // regression that made this feature useless on most sketches.
    assert.equal(diagram.kind, "drawing", `read a house and a sun as "${diagram.kind}"`);
    assert.equal(diagram.nodes.length, 0, "a drawing must not be turned into nodes");
    assert.ok(diagram.groups.length > 0, "a drawing with no groups is the old refusal wearing a hat");

    // Every id has to name a stroke that exists, or the compiler silently drops
    // the group and the user sees nothing happen for no stated reason.
    const known = new Set(elements.map((el) => String(el.id)));
    for (const group of diagram.groups) {
      assert.ok(group.ids.length > 0, `group "${group.label}" is empty`);
      for (const id of group.ids) {
        assert.ok(known.has(id), `group "${group.label}" names unknown stroke ${id}`);
      }
    }

    // One stroke, one group. parseDiagram enforces it; this catches the day it
    // stops, because the symptom otherwise is a drawing that tidies differently
    // depending on the order the model happened to list its groups in.
    const seen = new Set<string>();
    for (const group of diagram.groups) {
      for (const id of group.ids) {
        assert.ok(!seen.has(id), `stroke ${id} claimed by two groups`);
        seen.add(id);
      }
    }

    const result = polishSketch(elements, diagram.groups);

    assert.equal(result.elements.length, elements.length, "polish lost or invented a stroke");
    assert.ok(result.changed.length > 0, "the model grouped the drawing and nothing moved");

    // Whatever it touched has to be republishable, or the tidy is invisible to
    // everyone else on the board.
    const before = new Map(elements.map((el) => [String(el.id), Number(el.version)]));
    for (const id of result.changed) {
      const after = result.elements.find((el) => String(el.id) === id);
      assert.ok(after, `changed id ${id} is not in the output`);
      assert.ok(
        Number(after.version) > (before.get(id) ?? 0),
        `${id} changed without a version bump`,
      );
    }

    console.log(`    tidied ${result.changed.length}/${elements.length} strokes`);
  }),
  // A real call carrying a 900x640 PNG is seconds, not milliseconds, and the
  // retry chain can take three of them before giving up.
  120_000,
);
