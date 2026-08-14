import type { SyncElement } from "./types.js";

/**
 * Conflict resolution for concurrently edited scene elements.
 *
 * Excalidraw already stamps every element with a monotonically increasing
 * `version` plus a random `versionNonce`. That pair is enough to make merges
 * *commutative, associative and idempotent* — i.e. every replica converges on
 * the same scene regardless of the order updates arrive in — without shipping a
 * full CRDT runtime alongside the drawing SDK.
 *
 * The ordering is a total order on (version, versionNonce):
 *   higher version wins; on a tie the LOWER nonce wins.
 *
 * Ties are common in practice: two peers dragging the same shape both bump
 * 41 -> 42. Picking the lower nonce is arbitrary but *identical everywhere*,
 * which is the only property that matters.
 */
export function remoteWins(local: SyncElement | undefined, remote: SyncElement): boolean {
  if (local === undefined) return true;
  if (remote.version > local.version) return true;
  if (remote.version < local.version) return false;
  return remote.versionNonce < local.versionNonce;
}

export interface ReconcileOptions {
  /**
   * Elements the local user is actively manipulating. A remote update to one of
   * these is held back for a frame rather than applied mid-drag — without this,
   * a peer's stale echo yanks the shape out from under the cursor.
   */
  localHeldIds?: ReadonlySet<string>;
}

export interface ReconcileResult {
  elements: SyncElement[];
  /** Ids whose value actually changed. Empty means the scene can skip a repaint. */
  changed: string[];
}

/**
 * Merges `remote` into `local`, preserving `local`'s ordering (which is the
 * canvas z-order) and appending genuinely new elements at the end.
 */
export function reconcile(
  local: readonly SyncElement[],
  remote: readonly SyncElement[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const held = options.localHeldIds;
  const localIndex = new Map<string, number>();
  for (let i = 0; i < local.length; i++) {
    const el = local[i];
    if (el) localIndex.set(el.id, i);
  }

  const out = local.slice();
  const changed: string[] = [];
  const appended: SyncElement[] = [];

  for (const incoming of remote) {
    const at = localIndex.get(incoming.id);
    if (at === undefined) {
      // Never seen. A tombstone for an element we don't have is a no-op.
      if (incoming.isDeleted) continue;
      localIndex.set(incoming.id, out.length + appended.length);
      appended.push(incoming);
      changed.push(incoming.id);
      continue;
    }
    const current = out[at];
    if (held?.has(incoming.id)) continue;
    if (!remoteWins(current, incoming)) continue;
    out[at] = incoming;
    changed.push(incoming.id);
  }

  if (appended.length > 0) out.push(...appended);
  return { elements: out, changed };
}

/**
 * Diffs a scene against the versions we last transmitted and returns only the
 * elements a peer has not seen. On a busy board this is the difference between
 * shipping the whole scene 30×/s and shipping the two shapes that moved.
 */
export function collectDelta(
  elements: readonly SyncElement[],
  sent: Map<string, number>,
): SyncElement[] {
  const delta: SyncElement[] = [];
  for (const el of elements) {
    const seen = sent.get(el.id);
    if (seen === undefined || seen !== el.version) {
      delta.push(el);
      sent.set(el.id, el.version);
    }
  }
  return delta;
}

/**
 * Cheap scene fingerprint. Summing versions detects any mutation Excalidraw
 * makes (it never decrements a version), so an unchanged sum means an
 * unchanged scene and we can bail before doing any real diffing work.
 */
export function sceneFingerprint(elements: readonly SyncElement[]): number {
  let sum = 0;
  for (const el of elements) sum += el.version;
  return sum * 1_000_003 + elements.length;
}

/** Drops tombstones older than `ttlMs` so long-lived rooms don't grow forever. */
export function pruneTombstones(
  elements: readonly SyncElement[],
  ttlMs: number,
  now: number,
): SyncElement[] {
  return elements.filter(
    (el) => !el.isDeleted || now - (el.updated ?? now) < ttlMs,
  );
}
