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

  // Keyed by id, with a separate id list for ordering.
  //
  // An index-into-the-array formulation is the tempting one and it is wrong:
  // when a batch contains two updates to the same *new* id, the second lookup
  // finds an index that has been reserved but not yet written, so the write
  // lands past the end of the array. The result is a sparse array and a
  // duplicated element — which is exactly what a chunked delta or a large paste
  // produces in practice.
  const byId = new Map<string, SyncElement>();
  const order: string[] = [];
  for (const el of local) {
    if (!byId.has(el.id)) order.push(el.id);
    byId.set(el.id, el);
  }

  const changed: string[] = [];
  const seen = new Set<string>();

  for (const incoming of remote) {
    // Held elements are mid-gesture locally; a remote echo must not yank them.
    if (held?.has(incoming.id)) continue;

    const current = byId.get(incoming.id);
    if (!remoteWins(current, incoming)) continue;

    // Never seen — take it, *including* tombstones.
    //
    // Dropping a tombstone for an unknown element looks like an obvious
    // optimisation and destroys convergence. A delete can legitimately arrive
    // before the element it deletes: a peer that loaded a snapshot after the
    // delete, then received a stale broadcast of the element from a peer who had
    // not processed the delete yet, would resurrect it and never hear about the
    // deletion again. Keeping the tombstone is what makes the merge commutative,
    // and commutativity is the whole basis of every peer agreeing.
    //
    // The memory cost is bounded by pruneTombstones().
    if (current === undefined) order.push(incoming.id);

    byId.set(incoming.id, incoming);
    if (!seen.has(incoming.id)) {
      seen.add(incoming.id);
      changed.push(incoming.id);
    }
  }

  // Unchanged: hand back the original array so callers can compare by identity
  // and skip a repaint. Treated as immutable by every caller.
  if (changed.length === 0) return { elements: local as SyncElement[], changed };

  return { elements: order.map((id) => byId.get(id) as SyncElement), changed };
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
