import { MAX_BROADCAST_BYTES } from "./constants.js";
import type { SyncElement } from "./types.js";

/**
 * Realtime drops frames larger than its configured payload ceiling, and it does
 * so silently from the sender's point of view, the update simply never arrives.
 * Pasting a large diagram or running an AI recompose can easily produce a delta
 * in the megabytes, so anything oversized is split here and reassembled by the
 * receiver.
 */

export interface Chunked<T> {
  parts: T[][];
  gid: string;
}

let chunkCounter = 0;

/**
 * Greedily packs elements into frames under `maxBytes`.
 *
 * A single element bigger than the budget (a freedraw stroke with tens of
 * thousands of points, say) still gets its own frame, splitting *inside* an
 * element would break the atomicity reconciliation depends on. Those are rare
 * and Realtime's real ceiling sits comfortably above our conservative budget.
 */
export function chunkElements(
  elements: readonly SyncElement[],
  maxBytes: number = MAX_BROADCAST_BYTES,
): Chunked<SyncElement> {
  const gid = `c${(chunkCounter = (chunkCounter + 1) % 1e9).toString(36)}${Date.now().toString(36)}`;
  const parts: SyncElement[][] = [];
  let current: SyncElement[] = [];
  let size = 0;

  for (const el of elements) {
    const bytes = JSON.stringify(el).length;
    if (current.length > 0 && size + bytes > maxBytes) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(el);
    size += bytes;
  }
  if (current.length > 0) parts.push(current);
  if (parts.length === 0) parts.push([]);

  return { parts, gid };
}

interface PendingGroup {
  received: (SyncElement[] | undefined)[];
  total: number;
  count: number;
  startedAt: number;
}

/**
 * Reassembles chunked deltas. Groups that never complete, a peer that
 * disconnected mid-send, are evicted on the next call rather than by a timer,
 * so an idle board costs nothing.
 */
export class ChunkAssembler {
  private groups = new Map<string, PendingGroup>();

  constructor(private readonly ttlMs = 15_000) {}

  /** Returns the full element list once the final part arrives, else null. */
  push(
    gid: string,
    index: number,
    total: number,
    elements: SyncElement[],
    now: number = Date.now(),
  ): SyncElement[] | null {
    this.evictStale(now);

    if (total <= 1) return elements;

    let group = this.groups.get(gid);
    if (!group) {
      group = { received: new Array(total), total, count: 0, startedAt: now };
      this.groups.set(gid, group);
    }
    if (index >= group.total || group.received[index] !== undefined) return null;

    group.received[index] = elements;
    group.count++;
    if (group.count < group.total) return null;

    this.groups.delete(gid);
    return group.received.flat().filter((el): el is SyncElement => el !== undefined);
  }

  private evictStale(now: number): void {
    if (this.groups.size === 0) return;
    for (const [gid, group] of this.groups) {
      if (now - group.startedAt > this.ttlMs) this.groups.delete(gid);
    }
  }

  get pendingGroups(): number {
    return this.groups.size;
  }
}
