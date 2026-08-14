import type { PeerState } from "./types.js";

/**
 * Writer election.
 *
 * Supabase Realtime has no server-side hook, so somebody has to own the job of
 * persisting the board and answering catch-up requests. Rather than run a
 * dedicated process, the peers elect one of themselves from the presence map.
 *
 * The rule is a pure function of presence state, so every peer independently
 * arrives at the same answer with no extra round trips:
 *
 *   1. viewers are ineligible (they cannot write, RLS would reject them anyway)
 *   2. earliest `joinedAt` wins — the peer most likely to hold the fullest scene
 *   3. ties break on `peerId`, lexicographically
 *
 * Presence propagation is not instantaneous, so two peers can briefly both
 * believe they are the writer. That is survivable by design: the snapshot RPC
 * takes the version it read as a precondition, so the loser's write is rejected
 * as stale instead of clobbering the winner's.
 */
export function electWriter(peers: readonly PeerState[]): PeerState | null {
  let best: PeerState | null = null;
  for (const peer of peers) {
    if (peer.role === "viewer") continue;
    if (best === null) {
      best = peer;
      continue;
    }
    if (peer.joinedAt < best.joinedAt) {
      best = peer;
    } else if (peer.joinedAt === best.joinedAt && peer.peerId < best.peerId) {
      best = peer;
    }
  }
  return best;
}

export function isWriter(peers: readonly PeerState[], selfPeerId: string): boolean {
  return electWriter(peers)?.peerId === selfPeerId;
}

/**
 * Flattens Realtime's presence map (topic -> list of states published under
 * that key) into a deduped, stably ordered roster. A peer that rejoins quickly
 * can appear twice under one key; the newest entry wins.
 */
export function flattenPresence(
  raw: Record<string, unknown[]>,
): PeerState[] {
  const byPeer = new Map<string, PeerState>();
  for (const entries of Object.values(raw)) {
    for (const entry of entries) {
      const peer = entry as Partial<PeerState>;
      if (typeof peer?.peerId !== "string" || typeof peer.joinedAt !== "number") continue;
      const existing = byPeer.get(peer.peerId);
      if (!existing || existing.joinedAt < peer.joinedAt) {
        byPeer.set(peer.peerId, peer as PeerState);
      }
    }
  }
  return [...byPeer.values()].sort(
    (a, b) => a.joinedAt - b.joinedAt || (a.peerId < b.peerId ? -1 : 1),
  );
}
