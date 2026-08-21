"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SNAPSHOT_DEBOUNCE_MS,
  SNAPSHOT_MAX_DELAY_MS,
  TOMBSTONE_TTL_MS,
  pruneTombstones,
  type SyncElement,
} from "@limn/protocol";
import type { Database } from "@/lib/supabase/types";

interface WriterOptions {
  supabase: SupabaseClient<Database>;
  boardId: string;
  baseVersion: number;
  onSaved: (version: number, at: number) => void;
  /**
   * The scene as it stands right now.
   *
   * Only read after losing a compare-and-swap, where the payload that lost is
   * exactly the wrong thing to send again. By the time the retry fires, the
   * winner's elements have arrived over the channel and been merged, so asking
   * for the scene gets one containing both sides; replaying the captured array
   * gets one containing neither.
   */
  getScene: () => readonly SyncElement[];
}

export interface SnapshotWriter {
  /** Records that the scene changed. Scheduling is handled internally. */
  mark: (elements: readonly SyncElement[]) => void;
  /** Writes immediately, bypassing the debounce. */
  flush: (elements: readonly SyncElement[]) => Promise<void>;
  version: () => number;
  /** Adopts a version observed from another peer's `saved` broadcast. */
  observeVersion: (version: number) => void;
}

/**
 * Debounced snapshot persistence for whichever peer is currently the writer.
 *
 * Two timers, not one. The debounce keeps a continuous drag from issuing a write
 * per frame; the ceiling guarantees a save even if the user never stops drawing,
 * because a debounce alone can be starved indefinitely by steady input, exactly
 * what a long uninterrupted sketch looks like.
 *
 * Writes go through save_board_snapshot(), which compares the version we last
 * saw against the stored one. During a presence reshuffle two peers can briefly
 * both believe they are the writer; the loser's call comes back `saved: false`
 * with the current version, and is retried against that instead of overwriting.
 */
/**
 * How long to wait after losing a compare-and-swap before writing again.
 *
 * Long enough for the winner's broadcast to arrive and be merged, short enough
 * that the board is not left unsaved for a noticeable time.
 */
const CONTENTION_BACKOFF_MS = 600;

export function createSnapshotWriter(options: WriterOptions): SnapshotWriter {
  const { supabase, boardId, onSaved, getScene } = options;

  let version = options.baseVersion;
  let dirty: readonly SyncElement[] | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let ceiling: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  /** Resolves when the write currently in flight settles, so flush can wait. */
  let settled: Promise<void> = Promise.resolve();

  const clearTimers = () => {
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
    if (ceiling) {
      clearTimeout(ceiling);
      ceiling = null;
    }
  };

  async function write(elements: readonly SyncElement[], attempt = 0): Promise<void> {
    if (inFlight) {
      // Coalesce: whatever is newest will be picked up by the next scheduled run.
      dirty = elements;
      return;
    }
    inFlight = true;
    let done: () => void = () => {};
    settled = new Promise<void>((resolve) => (done = resolve));
    try {
      const payload = pruneTombstones(elements, TOMBSTONE_TTL_MS, Date.now());
      const { data, error } = await supabase.rpc("save_board_snapshot", {
        p_board_id: boardId,
        p_elements: payload as unknown as Record<string, unknown>[],
        p_base_version: version,
      });

      if (error) {
        console.error("[limn] snapshot write failed", error.message);
        return;
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return;

      if (row.saved) {
        version = row.version;
        onSaved(row.version, Date.now());
        return;
      }

      // Rejected as stale: somebody else saved between our read and our write.
      //
      // Adopt their version, but do NOT immediately rewrite the same elements.
      // That was the old behaviour and it undid the winner's save: our payload
      // predates theirs, so retrying it with their version number as the
      // precondition is a compare-and-swap that succeeds at overwriting exactly
      // the work we lost the race to.
      //
      // Instead, schedule a retry that reads the scene fresh. The winner's
      // elements reach us over the broadcast channel, the merge folds them in,
      // and the retry writes a scene that contains both sides rather than half
      // of one.
      //
      // What this must not do is `dirty = elements`, which is what it used to
      // do, one line under a comment saying not to. That reinstates the payload
      // that just lost, and clearTimers cancels the only thing that would have
      // replaced it, so unless a fresh mark() happened to land inside the
      // backoff the retry wrote the loser's scene against the winner's version:
      // a compare-and-swap that succeeds at overwriting precisely the work it
      // lost the race to. It also clobbered a merged mark() that arrived while
      // the RPC was still in flight, which is the very case the backoff is
      // waiting for.
      version = row.version;
      if (attempt < 2) {
        clearTimers();
        debounce = setTimeout(() => retry(attempt + 1), CONTENTION_BACKOFF_MS);
      }
    } finally {
      inFlight = false;
      done();
    }
  }

  const run = () => {
    clearTimers();
    const elements = dirty;
    dirty = null;
    if (elements) void write(elements);
  };

  /**
   * The scheduled half of a lost compare-and-swap.
   *
   * Prefers anything marked during the backoff, which is the merged scene, and
   * falls back to reading the canvas directly so a winner whose broadcast never
   * arrived does not leave this peer's own work unwritten.
   *
   * `attempt` is threaded through rather than left to default. run() calls
   * write() with no attempt, so the `attempt < 2` bound could never advance
   * past its first value and a board under sustained contention would retry
   * without limit.
   */
  const retry = (attempt: number) => {
    clearTimers();
    const elements = dirty ?? getScene();
    dirty = null;
    void write(elements, attempt);
  };

  return {
    mark(elements) {
      dirty = elements;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, SNAPSHOT_DEBOUNCE_MS);
      ceiling ??= setTimeout(run, SNAPSHOT_MAX_DELAY_MS);
    },

    async flush(elements) {
      clearTimers();
      dirty = null;

      // A flush that lands while a debounced write is already in flight used to
      // do nothing at all: write() coalesced it into `dirty` and returned, and
      // clearTimers had just cancelled the only thing that would have picked
      // `dirty` up again. That is exactly the tab-close case, so the last few
      // seconds of a session were the ones most likely to be lost. Wait for the
      // in-flight write, then write for real.
      if (inFlight) await settled;
      dirty = null;
      await write(elements);
    },

    version: () => version,

    observeVersion(observed) {
      // Another peer saved. Adopting their version means our next write is a
      // clean compare-and-swap instead of a guaranteed stale rejection.
      if (observed > version) version = observed;
    },
  };
}
