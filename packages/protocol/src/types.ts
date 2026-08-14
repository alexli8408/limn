/**
 * The whiteboard state that actually crosses the wire.
 *
 * We deliberately do NOT import Excalidraw's element types here: the realtime
 * server runs on Render with no DOM and must stay independent of the drawing
 * SDK's release cadence. Sync only needs the four fields that drive conflict
 * resolution; everything else rides along opaquely.
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

export interface PeerInfo {
  socketId: string;
  userId: string;
  name: string;
  color: string;
  avatarUrl?: string;
  role: Role;
  /** True when the peer authenticated anonymously (frictionless demo path). */
  guest: boolean;
}

export interface PointerState {
  x: number;
  y: number;
  /** Excalidraw's active tool, so remote cursors can render the right glyph. */
  tool?: string;
  button?: "up" | "down";
  selectedIds?: string[];
}

export interface SceneSnapshot {
  elements: SyncElement[];
  /** Server-assigned, strictly increasing per board. Used for optimistic UI. */
  version: number;
  /** Ids of files (images) referenced by the scene; blobs live in Supabase Storage. */
  fileIds?: string[];
}
