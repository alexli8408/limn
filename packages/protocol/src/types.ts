/**
 * The whiteboard state that actually crosses the wire.
 *
 * We deliberately do NOT import Excalidraw's element types here: this package
 * is consumed by the Node load-test harness and by edge runtimes with no DOM,
 * and it must stay independent of the drawing SDK's release cadence. Sync only
 * needs the four fields that drive conflict resolution; the rest of an element
 * rides along opaquely.
 */
export interface SyncMeta {
  id: string;
  /** Monotonic per-element counter, incremented by Excalidraw on every mutation. */
  version: number;
  /** Random tiebreaker for concurrent edits that landed on the same version. */
  versionNonce: number;
  /** Wall-clock ms of the last mutation. Advisory only — never trusted for ordering. */
  updated?: number;
  /** Excalidraw tombstones rather than removing, so deletes converge like any edit. */
  isDeleted?: boolean;
}

export type SyncElement = SyncMeta & Record<string, unknown>;

export type Role = "owner" | "editor" | "viewer";

/**
 * What each peer publishes into the Realtime presence map. Keyed by `peerId`,
 * which is per-tab rather than per-user — one person with two tabs open is two
 * peers, and both need distinct cursors.
 */
export interface PeerState {
  peerId: string;
  userId: string;
  name: string;
  color: string;
  avatarUrl?: string;
  role: Role;
  /** True when the peer authenticated anonymously (the frictionless demo path). */
  guest: boolean;
  /** Client clock at channel subscribe. Drives writer election — see election.ts. */
  joinedAt: number;
}

export interface CursorState {
  x: number;
  y: number;
  /** Excalidraw's active tool, so remote cursors can render the right glyph. */
  tool?: string;
  button?: "up" | "down";
  selectedIds?: string[];
  /** Local receipt time, used to fade out cursors that stopped reporting. */
  receivedAt?: number;
}

export interface SceneSnapshot {
  elements: SyncElement[];
  /** Strictly increasing per board, assigned by Postgres. Guards blind overwrites. */
  version: number;
  /** Ids of files (images) referenced by the scene; blobs live in Supabase Storage. */
  fileIds?: string[];
}

/** Connection lifecycle as surfaced to the UI. */
export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "error";
