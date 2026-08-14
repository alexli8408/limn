"use client";

import { useCallback, useRef, useState } from "react";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { recognizeStroke, type Point, type Recognition } from "@limn/shapes";
import type { SyncElement } from "@limn/protocol";

/**
 * Live stroke beautification.
 *
 * Runs entirely in the browser and entirely synchronously. This has to land in
 * the same frame the pen lifts, a shape that snaps 200 ms later reads as the
 * canvas fighting the user rather than helping them, which is why the OpenCV
 * service is not on this path. That service handles the harder cases the local
 * recogniser declines, on explicit request.
 */

/** Style properties the replacement inherits, so it looks like what was drawn. */
const INHERITED = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "frameId",
  "groupIds",
] as const;

export interface BeautifyStats {
  attempted: number;
  replaced: number;
  declined: number;
  lastKind: string | null;
  lastConfidence: number;
}

export interface BeautifyOptions {
  enabled: boolean;
  /** Minimum confidence to replace a stroke. Higher is more conservative. */
  threshold?: number;
  /** Applies the replacement to the canvas and to the sync layer. */
  commit: (next: SyncElement[]) => void;
}

interface FreedrawLike extends SyncElement {
  type: string;
  x: number;
  y: number;
  points: number[][];
}

function isFreedraw(el: SyncElement): el is FreedrawLike {
  return (
    el.type === "freedraw" &&
    Array.isArray((el as FreedrawLike).points) &&
    typeof el.x === "number" &&
    typeof el.y === "number"
  );
}

/** Freedraw points are element-relative and may carry pressure as a third value. */
function absolutePoints(el: FreedrawLike): Point[] {
  return el.points
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => [el.x + (p[0] as number), el.y + (p[1] as number)] as Point);
}

function buildReplacement(
  original: FreedrawLike,
  recognition: Recognition,
): SyncElement[] {
  const style: Record<string, unknown> = {};
  for (const key of INHERITED) {
    if (key in original) style[key] = original[key];
  }

  const { box, angle, kind, points } = recognition;

  // A recognised open path becomes a line/arrow; a closed one becomes a
  // container. Triangles and polygons have no primitive of their own, so they
  // are closed `line` elements, which is what Excalidraw's own tooling produces.
  const skeleton: Record<string, unknown> =
    kind === "line" || kind === "arrow" || kind === "triangle" || kind === "polygon"
      ? {
          type: kind === "arrow" ? "arrow" : "line",
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          points: points ?? [
            [0, 0],
            [box.width, box.height],
          ],
          ...style,
        }
      : {
          type: kind,
          x: box.x,
          y: box.y,
          width: Math.max(box.width, 1),
          height: Math.max(box.height, 1),
          angle,
          ...style,
        };

  return convertToExcalidrawElements([
    skeleton as NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number],
  ]) as unknown as SyncElement[];
}

export function useStrokeBeautify(options: BeautifyOptions) {
  const { enabled, threshold = 0.62, commit } = options;
  const [stats, setStats] = useState<BeautifyStats>({
    attempted: 0,
    replaced: 0,
    declined: 0,
    lastKind: null,
    lastConfidence: 0,
  });

  // Ids already considered. Excalidraw's onChange fires many times per stroke
  // and re-running recognition on each would both waste work and, once a
  // replacement exists, risk recognising our own output.
  const seen = useRef(new Set<string>());
  const drawingId = useRef<string | null>(null);

  /**
   * Called on every scene change. Beautification is triggered by the pen
   * *lifting*, detected as `appState.newElement` going from set to null, not by
   * a debounce, which would fire mid-stroke on any pause.
   */
  const onSceneChange = useCallback(
    (elements: readonly SyncElement[], appState: { newElement?: unknown }) => {
      if (!enabled) return;

      const drawing = appState.newElement as { id?: string; type?: string } | null;
      if (drawing?.id && drawing.type === "freedraw") {
        drawingId.current = drawing.id;
        return;
      }

      const finishedId = drawingId.current;
      drawingId.current = null;
      if (!finishedId || seen.current.has(finishedId)) return;
      seen.current.add(finishedId);

      const original = elements.find((el) => el.id === finishedId);
      if (!original || !isFreedraw(original) || original.isDeleted) return;

      const points = absolutePoints(original);
      if (points.length < 3) return;

      const recognition = recognizeStroke(points, { threshold: threshold * 0.9 });
      const accepted =
        recognition.kind !== "freedraw" && recognition.confidence >= threshold;

      setStats((previous) => ({
        attempted: previous.attempted + 1,
        replaced: previous.replaced + (accepted ? 1 : 0),
        declined: previous.declined + (accepted ? 0 : 1),
        lastKind: recognition.kind,
        lastConfidence: recognition.confidence,
      }));

      if (!accepted) return;

      const replacement = buildReplacement(original, recognition);
      if (replacement.length === 0) return;

      const now = Date.now();
      const next: SyncElement[] = elements.map((el) =>
        el.id === finishedId
          ? {
              // Tombstone rather than remove: a delete has to converge across
              // peers, and dropping the element from the array does not.
              ...el,
              isDeleted: true,
              version: el.version + 1,
              versionNonce: Math.floor(Math.random() * 2 ** 31),
              updated: now,
            }
          : el,
      );
      next.push(...replacement);
      for (const el of replacement) seen.current.add(el.id);

      commit(next);
    },
    [enabled, threshold, commit],
  );

  const reset = useCallback(() => {
    seen.current.clear();
    drawingId.current = null;
  }, []);

  return { onSceneChange, stats, reset };
}
