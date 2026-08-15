"use client";

import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { SyncElement } from "@limn/protocol";
import { planDiagram, type CompileOptions, type DiagramStats } from "./plan";
import type { LimnDiagram } from "./schema";

export { inkOf, type Ink, type CompileOptions } from "./plan";

/**
 * Turns a LimnDiagram into real Excalidraw elements.
 *
 * The decisions happen in ./plan; this only adapts them. Everything goes
 * through `convertToExcalidrawElements`, which takes the "skeleton" form
 * Excalidraw publishes for exactly this purpose. It is what generates seeds,
 * version nonces, fractional indices, bound text containers and, critically,
 * arrow bindings with correct focus and gap. Hand-building elements to avoid
 * the dependency means reimplementing all of that, and the failure mode is
 * arrows that look attached until the first time something moves.
 */

export interface CompileResult {
  elements: SyncElement[];
  /** Ids of input elements the diagram replaces; the caller tombstones these. */
  replacedIds: string[];
  stats: DiagramStats;
}

export function compileDiagram(
  diagram: LimnDiagram,
  options: CompileOptions,
): CompileResult {
  const plan = planDiagram(diagram, options);
  const elements = convertToExcalidrawElements(
    plan.skeletons as Parameters<typeof convertToExcalidrawElements>[0],
  ) as unknown as SyncElement[];

  return { elements, replacedIds: plan.replacedIds, stats: plan.stats };
}

/**
 * Marks the sketched originals as deleted rather than removing them.
 *
 * Deletion has to converge across peers, and dropping an element from the array
 * does not: a peer that never saw the removal would helpfully broadcast it back.
 * A tombstone is an ordinary edit and merges like one.
 */
export function tombstone(
  elements: readonly SyncElement[],
  ids: readonly string[],
): SyncElement[] {
  if (ids.length === 0) return [...elements];
  const doomed = new Set(ids);
  const now = Date.now();
  return elements.map((el) =>
    doomed.has(el.id) && !el.isDeleted
      ? {
          ...el,
          isDeleted: true,
          version: el.version + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
          updated: now,
        }
      : el,
  );
}
