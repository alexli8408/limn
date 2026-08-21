"use client";

import { useEffect, useRef } from "react";
import { exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { supabaseBrowser } from "@/lib/supabase/client";

interface Options {
  boardId: string;
  api: ExcalidrawImperativeAPI | null;
  /** Only the elected writer uploads, so N peers do not race on one object. */
  isWriter: boolean;
  /** Bumped by the snapshot writer; the signal that content actually changed. */
  savedVersion: number;
}

/**
 * How long the board has to sit still before its picture is worth taking.
 *
 * Long on purpose. A thumbnail decorates a page nobody is looking at while they
 * draw, so it must never compete with the snapshot writer or the broadcast path
 * for the main thread. Nothing breaks if it is a minute stale.
 */
const SETTLE_MS = 20_000;

/**
 * Keeps a board's dashboard thumbnail up to date.
 *
 * The board-thumbnails bucket, its RLS policies and boards.thumbnail_url were
 * all built and then never used, so the dashboard was a grid of text cards that
 * gave no clue which board was which. That is a good part of why every board
 * being called "Untitled board" hurt as much as it did.
 *
 * The object lives at `<boardId>/thumb.png`, not `<boardId>.png`, because the
 * storage policies resolve the owning board with path_board_id(name), which
 * reads the first path segment. A flat filename has no first segment and every
 * write would be refused.
 */
export function useBoardThumbnail({ boardId, api, isWriter, savedVersion }: Options) {
  const lastShot = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!api || !isWriter || savedVersion === 0) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      // Coalesce: a busy board bumps savedVersion often, and re-uploading on
      // every bump would be a steady trickle of megabytes for no benefit.
      if (Date.now() - lastShot.current < SETTLE_MS) return;

      const elements = api.getSceneElements();
      if (elements.length === 0) return;
      lastShot.current = Date.now();

      try {
        const blob = await exportToBlob({
          elements,
          appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
          files: api.getFiles(),
          mimeType: "image/png",
          // Well inside the bucket's 2MB cap even for a dense board, and larger
          // than the card ever renders it.
          maxWidthOrHeight: 640,
          exportPadding: 16,
        });

        const supabase = supabaseBrowser();
        const path = `${boardId}/thumb.png`;
        const { error: uploadError } = await supabase.storage
          .from("board-thumbnails")
          .upload(path, blob, { upsert: true, contentType: "image/png" });
        if (uploadError) throw uploadError;

        const { data } = supabase.storage.from("board-thumbnails").getPublicUrl(path);
        // Cache-busted on the version. The object path never changes and the
        // bucket is public, so without this the CDN would serve the first
        // thumbnail a board ever had for as long as it existed.
        await supabase
          .from("boards")
          .update({ thumbnail_url: `${data.publicUrl}?v=${savedVersion}` })
          .eq("id", boardId);
      } catch (error) {
        // Never surfaced. A missing thumbnail is a cosmetic gap on another page,
        // and interrupting someone's drawing to report one would be worse.
        console.warn("[limn] thumbnail skipped:", error);
      }
    }, SETTLE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [api, isWriter, savedVersion, boardId]);
}
