"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  BoardEvent,
  CURSOR_FLUSH_INTERVAL_MS,
  ChunkAssembler,
  MAX_BROADCAST_BYTES,
  MAX_ELEMENTS_PER_BOARD,
  PROTOCOL_VERSION,
  SCENE_FLUSH_INTERVAL_MS,
  boardChannel,
  chunkElements,
  collectDelta,
  decodeEvent,
  electWriter,
  flattenPresence,
  presenceColorFor,
  reconcile,
  sceneFingerprint,
  type ConnectionStatus,
  type CursorState,
  type PeerState,
  type Role,
  type SyncElement,
} from "@limn/protocol";
import { supabaseBrowser } from "@/lib/supabase/client";
import { createSnapshotWriter } from "./persistence";

export interface UseCollabOptions {
  boardId: string;
  userId: string;
  displayName: string;
  role: Role;
  guest: boolean;
  avatarUrl?: string;
  /** Scene as loaded from Postgres, plus the version it was read at. */
  initialElements: SyncElement[];
  initialVersion: number;
  /** Applies merged remote state to the canvas. Must not re-enter publishLocal. */
  onRemoteScene: (elements: SyncElement[], changed: string[]) => void;
}

/** A collaborator's in-flight AI generation, so the canvas is not silently busy. */
export interface PeerActivity {
  peerId: string;
  label: string;
  mode: "refine" | "recompose" | "prompt" | "vectorize";
}

export interface CollabHandle {
  status: ConnectionStatus;
  peers: PeerState[];
  peerActivity: PeerActivity | null;
  cursors: Map<string, CursorState & { peer: PeerState }>;
  isWriter: boolean;
  savedVersion: number;
  lastSavedAt: number | null;
  peerId: string;
  /** Call on every Excalidraw change; internally coalesced and diffed. */
  publishScene: (elements: readonly SyncElement[]) => void;
  publishCursor: (x: number, y: number, tool?: string, button?: "up" | "down") => void;
  announceAi: (
    phase: "start" | "done" | "error",
    mode: "refine" | "recompose" | "prompt" | "vectorize",
    label?: string,
  ) => void;
  /** Forces a snapshot write, e.g. before navigating away. */
  flush: () => Promise<void>;
}

/** How long to wait before retrying a flush that had nowhere to send. */
const OFFLINE_RETRY_MS = 1_000;

const newPeerId = (): string =>
  `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

/**
 * Board collaboration over Supabase Realtime.
 *
 * Supabase Realtime is a fan-out pipe with no server-side hook, so everything a
 * collaborative editor normally puts on a server has to live here and produce
 * the same answer on every client:
 *
 *   - convergence, via the (version, versionNonce) total order in @limn/protocol
 *   - persistence, by electing one peer from the presence map to do the writing
 *   - catch-up, because the snapshot a joiner loads is already seconds stale
 *
 * The hook owns the authoritative element map for this tab. Excalidraw is
 * treated as a view over it, not as the source of truth, because a remote update
 * and a local edit can land in the same frame and only one of them can win.
 */
export function useCollab(options: UseCollabOptions): CollabHandle {
  const {
    boardId,
    userId,
    displayName,
    role,
    guest,
    avatarUrl,
    initialElements,
    initialVersion,
    onRemoteScene,
  } = options;

  const supabase = supabaseBrowser();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [cursors, setCursors] = useState<Map<string, CursorState & { peer: PeerState }>>(
    new Map(),
  );
  const [peerActivity, setPeerActivity] = useState<PeerActivity | null>(null);
  const [savedVersion, setSavedVersion] = useState(initialVersion);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const peerId = useMemo(newPeerId, []);
  const color = useMemo(() => presenceColorFor(userId), [userId]);
  const joinedAt = useMemo(() => Date.now(), []);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const sceneRef = useRef<SyncElement[]>(initialElements);
  const sentVersions = useRef(new Map<string, number>());
  const pendingScene = useRef<SyncElement[] | null>(null);
  const pendingCursor = useRef<CursorState | null>(null);
  const sceneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assembler = useRef(new ChunkAssembler());
  const peersRef = useRef<PeerState[]>([]);
  const lastFingerprint = useRef(sceneFingerprint(initialElements));

  // Kept in refs as well as state: the channel callbacks are registered once and
  // would otherwise capture the first render's values forever.
  const onRemoteRef = useRef(onRemoteScene);
  onRemoteRef.current = onRemoteScene;

  const writer = useMemo(() => {
    const elected = electWriter(peers);
    return elected?.peerId ?? null;
  }, [peers]);
  const isWriter = writer === peerId;
  const isWriterRef = useRef(isWriter);
  isWriterRef.current = isWriter;

  const snapshots = useMemo(
    () =>
      createSnapshotWriter({
        supabase,
        boardId,
        baseVersion: initialVersion,
        onSaved: (version, at) => {
          setSavedVersion(version);
          setLastSavedAt(at);
          // Only announce over a joined socket. The first save can land before
          // the channel finishes joining, and send() on an unjoined channel
          // silently falls back to a REST post, which logs a deprecation warning
          // on every board open. Peers that miss this one pick the version up
          // from the next save or from their own HELLO.
          const channel = channelRef.current;
          if (channel?.state !== "joined") return;
          channel.send({
            type: "broadcast",
            event: BoardEvent.SAVED,
            payload: {
              from: peerId,
              v: PROTOCOL_VERSION,
              sceneVersion: version,
              at,
              elementCount: sceneRef.current.filter((el) => !el.isDeleted).length,
            },
          });
        },
      }),
    [supabase, boardId, initialVersion, peerId],
  );

  /* ---------------------------------------------------------------- */
  /* outbound                                                          */
  /* ---------------------------------------------------------------- */

  // Self-reference, so a flush that cannot send yet can reschedule itself.
  const flushSceneRef = useRef<() => void>(() => {});

  const flushScene = useCallback(() => {
    sceneTimer.current = null;
    const next = pendingScene.current;
    if (!next) return;

    // Check the channel before collecting, not after. collectDelta records what
    // it returns as sent, and an element marked sent is never offered again
    // until its version changes, so collecting while the socket is down threw
    // those edits away permanently: peers only saw them if the user happened to
    // touch the same elements again.
    const channel = channelRef.current;
    if (channel?.state !== "joined") {
      sceneTimer.current = setTimeout(() => flushSceneRef.current(), OFFLINE_RETRY_MS);
      return;
    }

    pendingScene.current = null;
    const delta = collectDelta(next, sentVersions.current);
    if (delta.length === 0) return;

    const { parts, gid } = chunkElements(delta, MAX_BROADCAST_BYTES);
    parts.forEach((part, index) => {
      channel.send({
        type: "broadcast",
        event: BoardEvent.SCENE,
        payload: {
          from: peerId,
          v: PROTOCOL_VERSION,
          elements: part,
          ...(parts.length > 1 ? { chunk: { gid, i: index, n: parts.length } } : {}),
        },
      });
    });
  }, [peerId]);

  const publishScene = useCallback(
    (elements: readonly SyncElement[]) => {
      // Cheap reject first: Excalidraw fires onChange on pointer moves and
      // selection changes too, and most of those mutate nothing.
      const fingerprint = sceneFingerprint(elements);
      if (fingerprint === lastFingerprint.current) return;
      lastFingerprint.current = fingerprint;

      const snapshot = elements.slice(0, MAX_ELEMENTS_PER_BOARD);
      sceneRef.current = snapshot;
      pendingScene.current = snapshot;
      if (isWriterRef.current) snapshots.mark(snapshot);

      if (sceneTimer.current === null) {
        sceneTimer.current = setTimeout(flushScene, SCENE_FLUSH_INTERVAL_MS);
      }
    },
    [flushScene, snapshots],
  );

  const cursorPresence = useCallback(
    (cursor: CursorState) => ({
      peerId,
      userId,
      name: displayName,
      color,
      role,
      guest,
      joinedAt,
      ...(avatarUrl ? { avatarUrl } : {}),
      cursor,
    }),
    [peerId, userId, displayName, color, role, guest, joinedAt, avatarUrl],
  );

  const flushCursor = useCallback(() => {
    cursorTimer.current = null;
    const cursor = pendingCursor.current;
    pendingCursor.current = null;
    if (!cursor) return;

    const channel = channelRef.current;
    if (!channel) return;

    // Viewers cannot broadcast, the Realtime insert policy only lets them touch
    // presence, so their cursor rides along in presence state instead.
    if (role === "viewer") {
      void channel.track(cursorPresence(cursor));
      return;
    }

    channel.send({
      type: "broadcast",
      event: BoardEvent.CURSOR,
      payload: { from: peerId, v: PROTOCOL_VERSION, ...cursor },
    });
  }, [peerId, role, cursorPresence]);

  const publishCursor = useCallback(
    (x: number, y: number, tool?: string, button?: "up" | "down") => {
      pendingCursor.current = { x, y, tool, button };
      if (cursorTimer.current === null) {
        cursorTimer.current = setTimeout(flushCursor, CURSOR_FLUSH_INTERVAL_MS);
      }
    },
    [flushCursor],
  );

  const announceAi = useCallback(
    (
      phase: "start" | "done" | "error",
      mode: "refine" | "recompose" | "prompt" | "vectorize",
      label?: string,
    ) => {
      channelRef.current?.send({
        type: "broadcast",
        event: BoardEvent.AI,
        payload: { from: peerId, v: PROTOCOL_VERSION, phase, mode, label },
      });
    },
    [peerId],
  );

  const flush = useCallback(async () => {
    flushScene();
    await snapshots.flush(sceneRef.current);
  }, [flushScene, snapshots]);

  /* ---------------------------------------------------------------- */
  /* inbound                                                           */
  /* ---------------------------------------------------------------- */

  const applyRemote = useCallback((incoming: SyncElement[]) => {
    if (incoming.length === 0) return;
    const { elements, changed } = reconcile(sceneRef.current, incoming);
    if (changed.length === 0) return;

    sceneRef.current = elements;
    lastFingerprint.current = sceneFingerprint(elements);
    // Remote elements are already accounted for as "sent", echoing them back to
    // the peer that authored them would loop forever.
    for (const el of incoming) sentVersions.current.set(el.id, el.version);
    if (isWriterRef.current) snapshots.mark(elements);
    onRemoteRef.current(elements, changed);
  }, [snapshots]);

  useEffect(() => {
    const channel = supabase.channel(boardChannel(boardId), {
      // Private channels are what make the realtime.messages RLS policies apply.
      // Without this the topic is unauthenticated and any client could subscribe.
      config: {
        private: true,
        broadcast: { self: false, ack: false },
        presence: { key: peerId },
      },
    });
    channelRef.current = channel;

    channel
      .on("broadcast", { event: BoardEvent.SCENE }, ({ payload }) => {
        const result = decodeEvent(BoardEvent.SCENE, payload);
        if (!result.ok) return;
        const { from, elements, chunk } = result.data;
        if (from === peerId) return;

        if (chunk) {
          const complete = assembler.current.push(chunk.gid, chunk.i, chunk.n, elements);
          if (complete) applyRemote(complete);
          return;
        }
        applyRemote(elements);
      })
      .on("broadcast", { event: BoardEvent.CURSOR }, ({ payload }) => {
        const result = decodeEvent(BoardEvent.CURSOR, payload);
        if (!result.ok || result.data.from === peerId) return;
        const { from, x, y, tool, button } = result.data;
        setCursors((previous) => {
          const peer = peersRef.current.find((p) => p.peerId === from);
          if (!peer) return previous;
          const next = new Map(previous);
          next.set(from, { x, y, tool, button, receivedAt: Date.now(), peer });
          return next;
        });
      })
      .on("broadcast", { event: BoardEvent.HELLO }, ({ payload }) => {
        const result = decodeEvent(BoardEvent.HELLO, payload);
        if (!result.ok || result.data.from === peerId) return;
        // Only the writer answers, so a joiner does not get one full scene per peer.
        if (!isWriterRef.current) return;
        if (result.data.fingerprint === lastFingerprint.current) return;

        const { parts, gid } = chunkElements(sceneRef.current, MAX_BROADCAST_BYTES);
        parts.forEach((part, index) => {
          channel.send({
            type: "broadcast",
            event: BoardEvent.SYNC,
            payload: {
              from: peerId,
              v: PROTOCOL_VERSION,
              to: result.data.from,
              elements: part,
              sceneVersion: snapshots.version(),
              ...(parts.length > 1 ? { chunk: { gid, i: index, n: parts.length } } : {}),
            },
          });
        });
      })
      .on("broadcast", { event: BoardEvent.SYNC }, ({ payload }) => {
        const result = decodeEvent(BoardEvent.SYNC, payload);
        if (!result.ok || result.data.to !== peerId) return;
        const { elements, chunk } = result.data;
        if (chunk) {
          const complete = assembler.current.push(chunk.gid, chunk.i, chunk.n, elements);
          if (complete) applyRemote(complete);
          return;
        }
        applyRemote(elements);
      })
      .on("broadcast", { event: BoardEvent.SAVED }, ({ payload }) => {
        const result = decodeEvent(BoardEvent.SAVED, payload);
        if (!result.ok) return;
        setSavedVersion(result.data.sceneVersion);
        setLastSavedAt(result.data.at);
        snapshots.observeVersion(result.data.sceneVersion);
      })
      .on("broadcast", { event: BoardEvent.AI }, ({ payload }) => {
        const result = decodeEvent(BoardEvent.AI, payload);
        if (!result.ok || result.data.from === peerId) return;
        const { from, phase, mode, label } = result.data;
        setPeerActivity((previous) => {
          if (phase === "start") return { peerId: from, label: label ?? "Someone", mode };
          // Only the peer that started it may clear it, or one person finishing
          // would hide another's still-running generation.
          return previous?.peerId === from ? null : previous;
        });
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState() as Record<string, unknown[]>;
        const roster = flattenPresence(state);
        peersRef.current = roster;
        setPeers(roster);

        const live = new Set(roster.map((p) => p.peerId));
        setCursors((previous) => {
          // A viewer's cursor arrives as presence state, not as a broadcast.
          const next = new Map<string, CursorState & { peer: PeerState }>();
          for (const entry of Object.values(state).flat()) {
            const record = entry as PeerState & { cursor?: CursorState };
            if (record?.peerId && record.peerId !== peerId && record.cursor) {
              next.set(record.peerId, {
                ...record.cursor,
                receivedAt: Date.now(),
                peer: record,
              });
            }
          }
          for (const [id, cursor] of previous) {
            if (live.has(id) && !next.has(id)) next.set(id, cursor);
          }
          return next;
        });
      })
      .subscribe((state, error) => {
        if (state === "SUBSCRIBED") {
          setStatus("connected");
          void channel.track({
            peerId,
            userId,
            name: displayName,
            color,
            role,
            guest,
            joinedAt,
            ...(avatarUrl ? { avatarUrl } : {}),
          });
          // Ask for anything newer than the snapshot we loaded. The persisted
          // scene can be up to the autosave interval behind live state.
          channel.send({
            type: "broadcast",
            event: BoardEvent.HELLO,
            payload: {
              from: peerId,
              v: PROTOCOL_VERSION,
              fingerprint: lastFingerprint.current,
            },
          });
        } else if (state === "CHANNEL_ERROR") {
          setStatus("error");
          if (error) console.error("[limn] realtime channel error", error);
        } else if (state === "TIMED_OUT") {
          setStatus("reconnecting");
        } else if (state === "CLOSED") {
          setStatus("offline");
        }
      });

    return () => {
      if (sceneTimer.current) clearTimeout(sceneTimer.current);
      if (cursorTimer.current) clearTimeout(cursorTimer.current);
      // Best-effort final save. Cannot be awaited during teardown, but the
      // writer election means whoever remains will persist anyway.
      void snapshots.flush(sceneRef.current);
      void supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [
    supabase,
    boardId,
    peerId,
    userId,
    displayName,
    color,
    role,
    guest,
    joinedAt,
    avatarUrl,
    applyRemote,
    snapshots,
  ]);

  /** Persist on tab close. `visibilitychange` fires where `beforeunload` does not. */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flush]);

  /** Drop cursors that stopped reporting, so a crashed tab's cursor disappears. */
  useEffect(() => {
    const timer = setInterval(() => {
      setCursors((previous) => {
        const now = Date.now();
        let mutated = false;
        const next = new Map(previous);
        for (const [id, cursor] of previous) {
          if (now - (cursor.receivedAt ?? 0) > 10_000) {
            next.delete(id);
            mutated = true;
          }
        }
        return mutated ? next : previous;
      });
    }, 4_000);
    return () => clearInterval(timer);
  }, []);

  return {
    status,
    peers,
    peerActivity,
    cursors,
    isWriter,
    savedVersion,
    lastSavedAt,
    peerId,
    publishScene,
    publishCursor,
    announceAi,
    flush,
  };
}
