import assert from "node:assert/strict";
import test from "node:test";
import {
  ChunkAssembler,
  chunkElements,
  collectDelta,
  electWriter,
  flattenPresence,
  reconcile,
  remoteWins,
  sceneFingerprint,
  pruneTombstones,
  type PeerState,
  type SyncElement,
} from "./index.js";

/**
 * Convergence tests.
 *
 * With no authoritative server, "every peer ends up with the same scene" is not
 * something the architecture gives us, it is a property of the merge function
 * that has to actually hold. These tests assert it directly, by delivering the
 * same set of edits to several simulated peers in randomised orders and
 * requiring identical results, rather than by inspecting the merge rule and
 * reasoning that it looks right.
 */

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const el = (
  id: string,
  version: number,
  versionNonce: number,
  extra: Record<string, unknown> = {},
): SyncElement => ({ id, version, versionNonce, ...extra });

/** Compares by identity of the winning value, ignoring array order. */
function normalise(elements: readonly SyncElement[]): string {
  return JSON.stringify(
    [...elements]
      .map((e) => [e.id, e.version, e.versionNonce, e.isDeleted ?? false, e.payload ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

test("the merge order is a strict total order", () => {
  // Higher version always wins, regardless of nonce.
  assert.equal(remoteWins(el("a", 1, 999), el("a", 2, 0)), true);
  assert.equal(remoteWins(el("a", 2, 0), el("a", 1, 999)), false);
  // On a tie the lower nonce wins, arbitrary, but identical everywhere.
  assert.equal(remoteWins(el("a", 2, 500), el("a", 2, 400)), true);
  assert.equal(remoteWins(el("a", 2, 400), el("a", 2, 500)), false);
  // Antisymmetry: never both.
  assert.equal(
    remoteWins(el("a", 2, 400), el("a", 2, 500)) &&
      remoteWins(el("a", 2, 500), el("a", 2, 400)),
    false,
  );
  // An unseen element is always taken.
  assert.equal(remoteWins(undefined, el("a", 0, 0)), true);
});

test("peers converge under randomised delivery orders", () => {
  const rand = prng(0xbeef);
  const PEERS = 5;
  const ROUNDS = 40;

  for (let round = 0; round < ROUNDS; round++) {
    // A pool of concurrent edits, including several that collide on the same
    // (id, version) with different nonces, the case that actually matters.
    const ops: SyncElement[] = [];
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) {
      const versions = 1 + Math.floor(rand() * 4);
      for (let v = 1; v <= versions; v++) {
        const collisions = 1 + Math.floor(rand() * 3);
        for (let c = 0; c < collisions; c++) {
          ops.push(
            el(id, v, Math.floor(rand() * 1_000_000), {
              payload: `${id}:${v}:${c}`,
              ...(rand() < 0.12 ? { isDeleted: true } : {}),
            }),
          );
        }
      }
    }

    const results: string[] = [];
    for (let peer = 0; peer < PEERS; peer++) {
      let scene: SyncElement[] = [];
      // Deliver in a fresh random order, in randomly sized batches, and replay
      // a slice of them, a reconnecting peer really does see duplicates.
      const delivery = shuffle(ops, rand);
      const withReplays = [...delivery, ...shuffle(delivery.slice(0, 5), rand)];

      let cursor = 0;
      while (cursor < withReplays.length) {
        const size = 1 + Math.floor(rand() * 4);
        const batch = withReplays.slice(cursor, cursor + size);
        cursor += size;
        scene = reconcile(scene, batch).elements;

        // Structural invariants, checked every step rather than only at the end.
        // These are what caught the index-reservation bug: the scene stayed
        // "converged" by value while quietly growing duplicate entries.
        assert.equal(
          new Set(scene.map((e) => e.id)).size,
          scene.length,
          `round ${round}: duplicate ids in the scene`,
        );
        assert.ok(
          scene.every((e) => e !== undefined),
          `round ${round}: sparse array, a write landed past the end`,
        );
      }
      results.push(normalise(scene));
    }

    const first = results[0];
    for (let i = 1; i < results.length; i++) {
      assert.equal(
        results[i],
        first,
        `round ${round}: peer ${i} diverged from peer 0`,
      );
    }
  }
});

test("merging is idempotent", () => {
  const local = [el("a", 3, 10, { payload: "x" }), el("b", 1, 20)];
  const remote = [el("a", 4, 5, { payload: "y" })];

  const once = reconcile(local, remote);
  const twice = reconcile(once.elements, remote);

  assert.equal(normalise(once.elements), normalise(twice.elements));
  assert.deepEqual(twice.changed, [], "a repeat delivery must report no change");
});

test("local z-order survives a merge, and new elements append", () => {
  const local = [el("z", 1, 1), el("y", 1, 2), el("x", 1, 3)];
  const remote = [el("y", 2, 1), el("new", 1, 1)];

  const { elements } = reconcile(local, remote);

  assert.deepEqual(
    elements.map((e) => e.id),
    ["z", "y", "x", "new"],
    "array position is canvas z-order and must not be reshuffled by a merge",
  );
  assert.equal(elements[1]?.version, 2, "the updated element should have been replaced");
});

test("an element being dragged locally is not yanked away mid-gesture", () => {
  const local = [el("a", 5, 10, { payload: "local-drag" })];
  const remote = [el("a", 9, 1, { payload: "stale-echo" })];

  const held = reconcile(local, remote, { localHeldIds: new Set(["a"]) });
  assert.equal(held.elements[0]?.payload, "local-drag");
  assert.deepEqual(held.changed, []);

  // Released, the same update applies normally.
  const free = reconcile(local, remote);
  assert.equal(free.elements[0]?.payload, "stale-echo");
});

test("a tombstone for an unseen element is retained, not discarded", () => {
  // Discarding it is the intuitive choice and it breaks commutativity: the
  // delete would be lost, and a later stale broadcast of the element from a peer
  // that had not yet processed the delete would resurrect it permanently.
  const { elements, changed } = reconcile([], [el("ghost", 4, 1, { isDeleted: true })]);
  assert.equal(elements.length, 1);
  assert.equal(elements[0]?.isDeleted, true);
  assert.deepEqual(changed, ["ghost"]);

  // And it must then suppress the element arriving late at a lower version.
  const late = reconcile(elements, [el("ghost", 3, 1, { payload: "back from the dead" })]);
  assert.equal(late.elements[0]?.isDeleted, true, "resurrected by a stale echo");
});

test("deletes converge like any other edit", () => {
  const remove = el("a", 6, 1, { isDeleted: true });
  const edit = el("a", 5, 1, { payload: "later-edit-lower-version" });

  const deleteFirst = reconcile(reconcile([], [remove]).elements, [edit]).elements;
  const editFirst = reconcile(reconcile([], [edit]).elements, [remove]).elements;

  assert.equal(normalise(deleteFirst), normalise(editFirst));
  assert.equal(deleteFirst[0]?.isDeleted, true, "the higher version wins, and it is the delete");
});

test("collectDelta emits only what a peer has not seen", () => {
  const sent = new Map<string, number>();
  const scene = [el("a", 1, 1), el("b", 1, 2)];

  assert.equal(collectDelta(scene, sent).length, 2, "first pass sends everything");
  assert.equal(collectDelta(scene, sent).length, 0, "an unchanged scene sends nothing");

  const moved = [el("a", 2, 3), el("b", 1, 2)];
  const delta = collectDelta(moved, sent);
  assert.equal(delta.length, 1);
  assert.equal(delta[0]?.id, "a");
});

test("the scene fingerprint changes whenever the scene does", () => {
  const base = [el("a", 1, 1), el("b", 2, 2)];
  assert.equal(sceneFingerprint(base), sceneFingerprint([el("a", 1, 9), el("b", 2, 9)]));
  assert.notEqual(sceneFingerprint(base), sceneFingerprint([el("a", 2, 1), el("b", 2, 2)]));
  assert.notEqual(sceneFingerprint(base), sceneFingerprint([...base, el("c", 1, 1)]));
});

test("tombstones are pruned only once they are older than the TTL", () => {
  const now = 1_000_000;
  const scene = [
    el("live", 1, 1),
    el("fresh", 2, 1, { isDeleted: true, updated: now - 1_000 }),
    el("stale", 2, 1, { isDeleted: true, updated: now - 100_000 }),
  ];
  const kept = pruneTombstones(scene, 50_000, now).map((e) => e.id);
  assert.deepEqual(kept, ["live", "fresh"]);
});

/* ------------------------------------------------------------------ */
/* writer election                                                     */
/* ------------------------------------------------------------------ */

const peer = (peerId: string, joinedAt: number, role: PeerState["role"] = "editor"): PeerState => ({
  peerId,
  userId: `u-${peerId}`,
  name: peerId,
  color: "#000",
  role,
  guest: false,
  joinedAt,
});

test("writer election is deterministic and order-independent", () => {
  const roster = [peer("c", 300), peer("a", 100), peer("b", 200)];
  const rand = prng(3);
  for (let i = 0; i < 20; i++) {
    assert.equal(electWriter(shuffle(roster, rand))?.peerId, "a");
  }
});

test("viewers are never elected, since they cannot write anyway", () => {
  const roster = [peer("viewer", 1, "viewer"), peer("editor", 999)];
  assert.equal(electWriter(roster)?.peerId, "editor");
  assert.equal(electWriter([peer("only-viewer", 1, "viewer")]), null);
});

test("ties break on peerId so all peers agree", () => {
  assert.equal(electWriter([peer("zz", 500), peer("aa", 500)])?.peerId, "aa");
});

test("presence flattening dedupes a fast rejoin, newest wins", () => {
  const roster = flattenPresence({
    p1: [peer("p1", 100), peer("p1", 400)],
    p2: [peer("p2", 200)],
    junk: [{ nope: true }, null],
  } as unknown as Record<string, unknown[]>);

  assert.deepEqual(roster.map((p) => p.peerId), ["p2", "p1"]);
  assert.equal(roster.find((p) => p.peerId === "p1")?.joinedAt, 400);
});

/* ------------------------------------------------------------------ */
/* chunking                                                            */
/* ------------------------------------------------------------------ */

test("oversized deltas split and reassemble exactly", () => {
  const big: SyncElement[] = Array.from({ length: 60 }, (_, i) =>
    el(`e${i}`, 1, i, { blob: "x".repeat(400) }),
  );

  const { parts, gid } = chunkElements(big, 2_000);
  assert.ok(parts.length > 1, "should have split");
  assert.equal(parts.flat().length, big.length, "no element may be lost");

  const assembler = new ChunkAssembler();
  let complete: SyncElement[] | null = null;
  // Deliver out of order; Realtime gives no ordering guarantee across frames.
  const order = shuffle(parts.map((_, i) => i), prng(11));
  for (const index of order) {
    const got = assembler.push(gid, index, parts.length, parts[index] as SyncElement[]);
    if (got) complete = got;
  }

  assert.ok(complete, "never completed");
  assert.equal(complete?.length, big.length);
  assert.equal(assembler.pendingGroups, 0, "completed groups must be released");
});

test("a duplicate chunk does not double-count toward completion", () => {
  const parts = [[el("a", 1, 1)], [el("b", 1, 2)]];
  const assembler = new ChunkAssembler();

  assert.equal(assembler.push("g", 0, 2, parts[0] as SyncElement[]), null);
  assert.equal(
    assembler.push("g", 0, 2, parts[0] as SyncElement[]),
    null,
    "a replayed chunk must not complete the group",
  );
  assert.ok(assembler.push("g", 1, 2, parts[1] as SyncElement[]), "should complete now");
});

test("an abandoned chunk group is evicted rather than leaked", () => {
  const assembler = new ChunkAssembler(1_000);
  assembler.push("dead", 0, 3, [el("a", 1, 1)], 0);
  assert.equal(assembler.pendingGroups, 1);

  assembler.push("other", 0, 2, [el("b", 1, 1)], 5_000);
  assert.equal(assembler.pendingGroups, 1, "the stale group should be gone");
});

test("a single-chunk delta bypasses the assembler entirely", () => {
  const assembler = new ChunkAssembler();
  const one = [el("a", 1, 1)];
  assert.deepEqual(assembler.push("g", 0, 1, one), one);
  assert.equal(assembler.pendingGroups, 0);
});

test("two updates to the same new id in one batch do not duplicate it", () => {
  // Regression: an index-based merge reserves a slot for the first, then the
  // second lookup writes past the end of the array, yielding a hole and a
  // duplicate. A chunked delta or a large paste produces exactly this shape.
  const { elements } = reconcile(
    [],
    [el("fresh", 1, 500, { payload: "first" }), el("fresh", 2, 100, { payload: "second" })],
  );

  assert.equal(elements.length, 1, "should be one element, not two");
  assert.equal(elements[0]?.payload, "second", "the higher version should win");
  assert.ok(
    elements.every((e) => e !== undefined),
    "no holes",
  );
});

test("an unchanged merge returns the original array by identity", () => {
  const local = [el("a", 5, 1)];
  const { elements, changed } = reconcile(local, [el("a", 2, 1)]);
  assert.equal(elements, local, "callers compare by identity to skip a repaint");
  assert.deepEqual(changed, []);
});
