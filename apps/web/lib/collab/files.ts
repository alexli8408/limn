"use client";

import { supabaseBrowser } from "@/lib/supabase/client";

/**
 * Image bytes for a board.
 *
 * Excalidraw splits a scene in two: elements, which carry only a `fileId`, and a
 * separate file map holding the actual bytes. Sync and snapshots cover the
 * elements. Nothing covers the file map, so an image inserted by one peer shows
 * as an empty frame for everyone else, and for the author too after a reload.
 *
 * These bridge that gap using the `board-files` bucket. The same RLS that guards
 * the board guards the objects, because the storage policies key off the first
 * path segment, which is the board id.
 */

export interface BinaryFileLike {
  id: string;
  dataURL: string;
  mimeType: string;
  created: number;
}

const path = (boardId: string, fileId: string) => `${boardId}/${fileId}.png`;

function toDataUrl(mimeType: string, bytes: ArrayBuffer): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * Fetches every image the scene references but the canvas does not yet hold.
 *
 * Called on open and after a remote update, so a peer's illustration appears
 * without a reload. Downloads run in parallel and a failure is skipped rather
 * than thrown: one unreadable image should not stop a board from loading.
 */
export async function loadBoardFiles(
  boardId: string,
  fileIds: readonly string[],
): Promise<BinaryFileLike[]> {
  if (fileIds.length === 0) return [];
  const supabase = supabaseBrowser();

  const results = await Promise.all(
    fileIds.map(async (fileId) => {
      const { data, error } = await supabase.storage
        .from("board-files")
        .download(path(boardId, fileId));
      if (error || !data) {
        console.warn(`[limn] could not load image ${fileId}:`, error?.message);
        return null;
      }
      return {
        id: fileId,
        dataURL: toDataUrl(data.type || "image/png", await data.arrayBuffer()),
        mimeType: data.type || "image/png",
        created: Date.now(),
      } satisfies BinaryFileLike;
    }),
  );

  return results.filter((file): file is BinaryFileLike => file !== null);
}

/** Ids referenced by image elements in the scene, skipping tombstoned ones. */
export function referencedFileIds(elements: readonly { [k: string]: unknown }[]): string[] {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el.type === "image" && typeof el.fileId === "string" && !el.isDeleted) {
      ids.add(el.fileId);
    }
  }
  return [...ids];
}
