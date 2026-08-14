/**
 * Wire-level constants shared by the browser client and the Render websocket
 * server. Anything that both sides must agree on numerically lives here so the
 * two can never drift.
 */

/** Bumped whenever the message union changes shape incompatibly. */
export const PROTOCOL_VERSION = 3;

/** Scene deltas are coalesced into at most one frame every N ms (~30 fps). */
export const SCENE_FLUSH_INTERVAL_MS = 33;

/** Pointer positions are ephemeral; 20 fps is indistinguishable from 60 here. */
export const POINTER_FLUSH_INTERVAL_MS = 50;

/** Client heartbeat period. Server terminates a socket after 2.5 missed beats. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 37_500;

/** Server persists a dirty room at most this often, and at least this often. */
export const SNAPSHOT_DEBOUNCE_MS = 4_000;
export const SNAPSHOT_MAX_DELAY_MS = 20_000;

/** Hard ceilings. Exceeding any of these closes the socket with a policy code. */
export const MAX_MESSAGE_BYTES = 1_500_000;
export const MAX_ELEMENTS_PER_UPDATE = 2_000;
export const MAX_ELEMENTS_PER_ROOM = 20_000;
export const MAX_PEERS_PER_ROOM = 64;

/** Token-bucket rate limit for inbound messages, per socket. */
export const RATE_LIMIT_CAPACITY = 240;
export const RATE_LIMIT_REFILL_PER_SEC = 120;

/** Deleted elements are tombstoned this long before being dropped from state. */
export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

/** Close codes above 4000 are application-defined. */
export const CloseCode = {
  NORMAL: 1000,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  UNAUTHORIZED: 4001,
  FORBIDDEN: 4003,
  ROOM_FULL: 4004,
  RATE_LIMITED: 4029,
  PROTOCOL_MISMATCH: 4426,
} as const;

export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/** Deterministic presence palette — index by a hash of the user id. */
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

export function presenceColorFor(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % PRESENCE_COLORS.length;
  return PRESENCE_COLORS[idx] ?? PRESENCE_COLORS[0];
}
