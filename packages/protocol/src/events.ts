import { z } from "zod";
import { MAX_ELEMENTS_PER_UPDATE, MAX_PEERS_PER_BOARD } from "./constants.js";

/**
 * Broadcast events carried over the board's Supabase Realtime channel.
 *
 * Realtime is a dumb pipe: it authorizes a peer onto a topic and fans out
 * whatever JSON that peer sends. There is no server to sanitise payloads, so
 * *every* inbound event is parsed here before it is allowed near scene state.
 * A compromised or merely out-of-date client must not be able to corrupt a
 * board for everyone else.
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

export const peerStateSchema = z.object({
  peerId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  color: z.string().max(32),
  avatarUrl: z.string().url().max(512).optional(),
  role: roleSchema,
  guest: z.boolean(),
  joinedAt: z.number(),
});

/** Present on every event so receivers can drop their own echo cheaply. */
const envelope = {
  from: z.string().min(1).max(64),
  v: z.number().int(),
};

/**
 * A delta that exceeded the frame budget is split. Receivers buffer by `gid`
 * and only apply once all `n` parts land; an incomplete group is discarded
 * after a timeout rather than applied half-way.
 */
const chunkSchema = z.object({
  gid: z.string().max(64),
  i: z.number().int().nonnegative(),
  n: z.number().int().positive(),
});

export const BoardEvent = {
  SCENE: "scene",
  CURSOR: "cursor",
  HELLO: "hello",
  SYNC: "sync",
  SAVED: "saved",
  AI: "ai",
} as const;

export type BoardEventName = (typeof BoardEvent)[keyof typeof BoardEvent];

/** Incremental element changes. The workhorse, one every ~33 ms while drawing. */
export const sceneEventSchema = z.object({
  ...envelope,
  elements: z.array(syncElementSchema).max(MAX_ELEMENTS_PER_UPDATE),
  chunk: chunkSchema.optional(),
});

/** Ephemeral pointer position. Never persisted, never reconciled. */
export const cursorEventSchema = z.object({
  ...envelope,
  x: z.number().finite(),
  y: z.number().finite(),
  tool: z.string().max(32).optional(),
  button: z.enum(["up", "down"]).optional(),
  selectedIds: z.array(z.string().max(128)).max(256).optional(),
});

/**
 * A peer announces itself and asks for authoritative catch-up. The persisted
 * snapshot it just loaded may be seconds stale; the elected writer answers
 * with everything newer.
 */
export const helloEventSchema = z.object({
  ...envelope,
  /** Fingerprint of the snapshot the joiner loaded, so the writer can skip a no-op. */
  fingerprint: z.number(),
});

/** The writer's targeted full-scene reply to a `hello`. */
export const syncEventSchema = z.object({
  ...envelope,
  to: z.string().min(1).max(64),
  elements: z.array(syncElementSchema).max(MAX_PEERS_PER_BOARD * 1000),
  sceneVersion: z.number().int(),
  chunk: chunkSchema.optional(),
});

/** Broadcast after a successful snapshot write so every peer can show "saved". */
export const savedEventSchema = z.object({
  ...envelope,
  sceneVersion: z.number().int(),
  at: z.number(),
  elementCount: z.number().int().nonnegative(),
});

/** Lets collaborators see "Alex is generating a diagram…" instead of a silent freeze. */
export const aiEventSchema = z.object({
  ...envelope,
  phase: z.enum(["start", "done", "error"]),
  mode: z.enum(["refine", "recompose", "prompt", "vectorize"]),
  label: z.string().max(120).optional(),
});

export type SceneEvent = z.infer<typeof sceneEventSchema>;
export type CursorEvent = z.infer<typeof cursorEventSchema>;
export type HelloEvent = z.infer<typeof helloEventSchema>;
export type SyncEvent = z.infer<typeof syncEventSchema>;
export type SavedEvent = z.infer<typeof savedEventSchema>;
export type AiEvent = z.infer<typeof aiEventSchema>;

export const eventSchemas = {
  [BoardEvent.SCENE]: sceneEventSchema,
  [BoardEvent.CURSOR]: cursorEventSchema,
  [BoardEvent.HELLO]: helloEventSchema,
  [BoardEvent.SYNC]: syncEventSchema,
  [BoardEvent.SAVED]: savedEventSchema,
  [BoardEvent.AI]: aiEventSchema,
} as const;

export type EventPayloadMap = {
  [BoardEvent.SCENE]: SceneEvent;
  [BoardEvent.CURSOR]: CursorEvent;
  [BoardEvent.HELLO]: HelloEvent;
  [BoardEvent.SYNC]: SyncEvent;
  [BoardEvent.SAVED]: SavedEvent;
  [BoardEvent.AI]: AiEvent;
};

/**
 * Validates an inbound broadcast payload. Returns a discriminated result rather
 * than throwing, a malformed frame is a routine event on a public channel, not
 * an exceptional one, and the hot path should not pay for stack capture.
 */
export function decodeEvent<K extends BoardEventName>(
  name: K,
  payload: unknown,
): { ok: true; data: EventPayloadMap[K] } | { ok: false; reason: string } {
  const schema = eventSchemas[name];
  if (!schema) return { ok: false, reason: "unknown_event" };
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, reason: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid" };
  }
  return { ok: true, data: result.data as EventPayloadMap[K] };
}
