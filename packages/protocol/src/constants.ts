/**
 * Constants shared by every peer on a board. Supabase Realtime gives us a
 * WebSocket fan-out but no server-side logic, so all convergence rules live
 * here and each client enforces them identically.
 */

/** Bumped whenever the broadcast event union changes shape incompatibly. */
export const PROTOCOL_VERSION = 3;

/** Channel naming. Realtime authorization policies match on this prefix. */
export const BOARD_CHANNEL_PREFIX = "board:";
export const boardChannel = (boardId: string) => `${BOARD_CHANNEL_PREFIX}${boardId}`;

/* ---------------------------------------------------------------- */
/* pacing                                                            */
/* ---------------------------------------------------------------- */

/** Scene deltas are coalesced into at most one frame every N ms (~30 fps). */
export const SCENE_FLUSH_INTERVAL_MS = 33;

/** Cursors are ephemeral; 20 fps is indistinguishable from 60 and costs 1/3. */
export const CURSOR_FLUSH_INTERVAL_MS = 50;

/**
 * Realtime's client-side token bucket. The default of 10/s starves a 30 fps
 * scene channel, so we raise it and stay under it with our own coalescing.
 */
export const REALTIME_EVENTS_PER_SECOND = 40;

/** Snapshot cadence for the elected writer. Debounce, with a hard ceiling. */
export const SNAPSHOT_DEBOUNCE_MS = 4_000;
export const SNAPSHOT_MAX_DELAY_MS = 20_000;

/** A peer that has not refreshed presence in this long is treated as gone. */
export const PEER_STALE_MS = 45_000;

/* ---------------------------------------------------------------- */
/* limits                                                            */
/* ---------------------------------------------------------------- */

/**
 * Realtime rejects oversized frames outright, so large deltas are split into
 * chunks below this budget. Kept well under the platform ceiling to leave room
 * for the Phoenix envelope and base64 expansion of embedded file ids.
 */
export const MAX_BROADCAST_BYTES = 200_000;
export const MAX_ELEMENTS_PER_UPDATE = 2_000;
export const MAX_ELEMENTS_PER_BOARD = 20_000;
export const MAX_PEERS_PER_BOARD = 64;

/** Deleted elements are tombstoned this long before being dropped from state. */
export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------- */
/* presence                                                          */
/* ---------------------------------------------------------------- */

export const PRESENCE_COLORS = [
  "#e03131",
  "#1971c2",
  "#2f9e44",
  "#f08c00",
  "#9c36b5",
  "#0c8599",
  "#e8590c",
  "#5f3dc4",
  "#c2255c",
  "#087f5b",
] as const;

/** FNV-1a so every peer independently derives the same colour for a user. */
export function presenceColorFor(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % PRESENCE_COLORS.length;
  return PRESENCE_COLORS[idx] ?? PRESENCE_COLORS[0];
}
