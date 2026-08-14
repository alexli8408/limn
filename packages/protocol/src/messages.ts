import { z } from "zod";
import {
  MAX_ELEMENTS_PER_UPDATE,
  MAX_PEERS_PER_ROOM,
  PROTOCOL_VERSION,
} from "./constants.js";

/**
 * Every frame is a discriminated union on `t`. Single-character-ish tags keep
 * pointer frames small — at 20 Hz × 30 peers the tag alone would otherwise be
 * a meaningful slice of bandwidth.
 */

const syncElementSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.number().int().nonnegative(),
    versionNonce: z.number().int(),
    updated: z.number().int().nonnegative().optional(),
    isDeleted: z.boolean().optional(),
  })
  .passthrough();

const roleSchema = z.enum(["owner", "editor", "viewer"]);

export const peerInfoSchema = z.object({
  socketId: z.string(),
  userId: z.string(),
  name: z.string().max(64),
  color: z.string().max(32),
  avatarUrl: z.string().url().max(512).optional(),
  role: roleSchema,
  guest: z.boolean(),
});

/* ------------------------------------------------------------------ */
/* client -> server                                                    */
/* ------------------------------------------------------------------ */

export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("join"),
    v: z.number().int(),
    boardId: z.string().uuid(),
    /** Supabase access token, or a share token for link-based access. */
    token: z.string().max(4096).optional(),
    shareToken: z.string().max(128).optional(),
    name: z.string().min(1).max(64),
    avatarUrl: z.string().url().max(512).optional(),
  }),
  z.object({
    t: z.literal("update"),
    elements: z.array(syncElementSchema).max(MAX_ELEMENTS_PER_UPDATE),
  }),
  z.object({
    t: z.literal("pointer"),
    x: z.number().finite(),
    y: z.number().finite(),
    tool: z.string().max(32).optional(),
    button: z.enum(["up", "down"]).optional(),
    selectedIds: z.array(z.string().max(128)).max(256).optional(),
  }),
  z.object({ t: z.literal("pointerLeave") }),
  z.object({ t: z.literal("ping"), ts: z.number() }),
  /** Explicit flush request, e.g. right before the tab is hidden or closed. */
  z.object({ t: z.literal("save") }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/* ------------------------------------------------------------------ */
/* server -> client                                                    */
/* ------------------------------------------------------------------ */

export const serverMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    v: z.number().int(),
    socketId: z.string(),
    boardId: z.string(),
    role: roleSchema,
    self: peerInfoSchema,
    peers: z.array(peerInfoSchema).max(MAX_PEERS_PER_ROOM),
    elements: z.array(syncElementSchema),
    sceneVersion: z.number().int(),
    serverTs: z.number(),
  }),
  z.object({ t: z.literal("peerJoin"), peer: peerInfoSchema }),
  z.object({ t: z.literal("peerLeave"), socketId: z.string() }),
  z.object({
    t: z.literal("update"),
    from: z.string(),
    elements: z.array(syncElementSchema),
    sceneVersion: z.number().int(),
  }),
  z.object({
    t: z.literal("pointer"),
    from: z.string(),
    x: z.number(),
    y: z.number(),
    tool: z.string().optional(),
    button: z.enum(["up", "down"]).optional(),
    selectedIds: z.array(z.string()).optional(),
  }),
  z.object({ t: z.literal("pointerLeave"), from: z.string() }),
  z.object({ t: z.literal("pong"), ts: z.number(), serverTs: z.number() }),
  z.object({
    t: z.literal("saved"),
    sceneVersion: z.number().int(),
    at: z.number(),
    elementCount: z.number().int(),
  }),
  z.object({
    t: z.literal("error"),
    code: z.string(),
    message: z.string(),
    fatal: z.boolean().default(false),
  }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

export type ServerMessageOf<T extends ServerMessage["t"]> = Extract<
  ServerMessage,
  { t: T }
>;

/**
 * Parses an inbound client frame. Returns a discriminated result rather than
 * throwing: a malformed frame is a routine event on a public endpoint, not an
 * exceptional one, and the hot path should not pay for stack capture.
 */
export function decodeClientMessage(
  raw: string,
): { ok: true; msg: ClientMessage } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }
  const result = clientMessageSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: result.error.issues[0]?.message ?? "invalid_shape" };
  }
  if (result.data.t === "join" && result.data.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: "protocol_version_mismatch" };
  }
  return { ok: true, msg: result.data };
}

export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
