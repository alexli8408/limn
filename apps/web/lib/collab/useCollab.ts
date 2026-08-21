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
  /**
   * The canvas as it is right now, used as the merge base.
   *
   * Without this the base was sceneRef, which only advances inside
   * publishScene, which only runs from Excalidraw's onChange, which is
   * dispatched after a React commit and throttled through rAF. The ref
   * therefore trailed the live canvas by at least a frame, and the merged array
   * goes to updateScene, which replaces every element. Anything created in that
   * lag window was not in the base and so was deleted: a stroke begun a few
   * milliseconds before a peer's frame landed vanished mid-draw.
   */
  getLiveElements?: () => SyncElement[];
  /**
   * Ids the local user is currently manipulating: the selection, plus whatever
   * is under a pointer that is down.
   *
   * reconcile has taken localHeldIds since it was written and no caller ever
   * supplied it, so a peer's echo landing mid-drag replaced the object being
   * dragged and the gesture jumped to somebody else's version of it.
   */
  getHeldIds?: () => ReadonlySet<string>;
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
  /**
   * The scene is past MAX_ELEMENTS_PER_BOARD. Advisory: nothing is dropped or
   * blocked, but sync and saving both get slower from here, and a board this
   * size is usually an accident rather than a drawing.
   */
  atCapacity: boolean;
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
  /** Tears the channel down and joins again, for a Retry the user asked for. */
  reconnect: () => void;
}

/** How long to wait before retrying a flush that had nowhere to send. */
const OFFLINE_RETRY_MS = 1_000;

/**
 * Viewer cursors go out at 4/s, not at the editor's rate.
 *
 * An editor's cursor is a broadcast, which peers handle cheaply. A viewer has no
 * broadcast permission so their cursor rides presence instead, and every
 * presence update forces a full roster rebuild and re-render on every other
 * peer. That asymmetry is not obvious from the call site, which is why both used
 * to share one interval.
 */
const VIEWER_CURSOR_INTERVAL_MS = 250;

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
    getLiveElements,
    getHeldIds,
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
  /**
   * True while the scene is larger than MAX_ELEMENTS_PER_BOARD. Reported, not
   * enforced, see the note in publishScene. The ref shadows the state so the
   * hot path can compare without reading a value it would have to depend on.
   */
  const [atCapacity, setAtCapacity] = useState(false);
  /**
   * Bumped to force a fresh subscribe.
   *
   * Supabase reconnects on its own, but not always promptly and not at all once
   * a channel has errored, so a user staring at "Not connected" needs a way to
   * ask for a retry rather than reloading and risking unsaved work.
   */
  const [generation, setGeneration] = useState(0);

  const peerId = useMemo(newPeerId, []);
  const color = useMemo(() => presenceColorFor(userId), [userId]);
  const joinedAt = useMemo(() => Date.now(), []);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const sceneRef = useRef<readonly SyncElement[]>(initialElements);
  const sentVersions = useRef(new Map<string, number>());
  const pendingScene = useRef<readonly SyncElement[] | null>(null);
  const pendingCursor = useRef<CursorState | null>(null);
  const sceneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assembler = useRef(new ChunkAssembler());
  const peersRef = useRef<PeerState[]>([]);
  const lastViewerTrack = useRef(0);
  /** Cheap identity of the roster, so an unchanged one does not re-render. */
  const rosterKey = useRef("");
  const lastFingerprint = useRef(sceneFingerprint(initialElements));
  const overCapacity = useRef(false);
  /** Remote updates withheld while the local user is mid-gesture. See applyRemote. */
  const deferredRemote = useRef(new Map<string, SyncElement>());
  const drainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyRemoteRef = useRef<(incoming: SyncElement[]) => void>(() => {});

  // Kept in refs as well as state: the channel callbacks are registered once and
  // would otherwise capture the first render's values forever.
  const onRemoteRef = useRef(onRemoteScene);
  onRemoteRef.current = onRemoteScene;
  const liveRef = useRef(getLiveElements);
  liveRef.current = getLiveElements;
  const heldRef = useRef(getHeldIds);
  heldRef.current = getHeldIds;

  const writer = useMemo(() => {
    const elected = electWriter(peers);
    return elected?.peerId ?? null;
  }, [peers]);

  /**
   * With an empty roster there is nobody to elect, and the old expression made
   * that mean "not me", so nothing was the writer and nothing saved.
   *
   * The roster is empty for the first moment of every session, before presence
   * syncs, and it stays empty for the whole session whenever Realtime is
   * unreachable. Postgres is a separate service and is usually fine in that
   * case, so the board could have been saved the entire time. Someone drawing
   * through a Realtime outage would have been told their changes were only on
   * this screen, which is true, and then found they were nowhere at all.
   *
   * Alone means responsible. If presence later names someone else, this peer
   * stands down, and the brief overlap where two peers both believe they are
   * the writer is what the snapshot compare-and-swap is there for.
   */
  const isWriter = writer === null ? role !== "viewer" : writer === peerId;
  const isWriterRef = useRef(isWriter);
  isWriterRef.current = isWriter;

  /**
   * Frozen at mount, and the name is the reason: it is where this session
   * started, not a value that should keep arriving.
   *
   * It used to be read live, which made it a dependency of the snapshot writer
   * memo, which is a dependency of applyRemote, which is a dependency of the
   * channel effect. So a change to it tore down the Realtime channel and joined
   * again. The page is force-dynamic and re-reads the snapshot version on every
   * render, and every autosave bumps that version, so any server action calling
   * revalidatePath on this route, which the share dialog and rename both do,
   * handed back a payload with a new number and dropped the socket.
   *
   * The rejoin is not free. While this peer is out of presence the others
   * re-elect a writer, and a stroke broadcast into the gap is already recorded
   * in the sender's sentVersions, so it is never offered again and is missing
   * from the snapshot the writer goes on to persist. Changing the share role
   * could cost a peer the line they were drawing at the time.
   *
   * The writer tracks its own version after the first save anyway, so a fresh
   * baseVersion mid-session is not a correction, it is a reset of the
   * compare-and-swap base to a number this session has already moved past.
   */
  const baseVersion = useRef(initialVersion).current;

  const snapshots = useMemo(
    () =>
      createSnapshotWriter({
        supabase,
        boardId,
        baseVersion,
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
    [supabase, boardId, baseVersion, peerId],
  );

  /* ---------------------------------------------------------------- */
  /* outbound                                                          */
  /* ---------------------------------------------------------------- */

  // Self-reference, so a flush that cannot send yet can reschedule itself.
  const flushSceneRef = useRef<() => Promise<void>>(async () => {});

  const flushScene = useCallback(async () => {
    sceneTimer.current = null;
    const next = pendingScene.current;
    if (!next) return;

    // Check the channel before touching any bookkeeping. An element recorded as
    // sent is never offered again until its version changes, so recording one
    // the socket never carried threw that edit away permanently: peers only saw
    // it if the user happened to touch the same element a second time.
    const channel = channelRef.current;
    if (channel?.state !== "joined") {
      sceneTimer.current = setTimeout(() => void flushSceneRef.current(), OFFLINE_RETRY_MS);
      return;
    }

    // Diff without recording. collectDelta marks as it collects, which is the
    // same trap one level down: a send that fails, times out, or loses one chunk
    // of a group would still leave every id in that group marked as delivered.
    const sent = sentVersions.current;
    const delta = next.filter((el) => sent.get(el.id) !== el.version);
    if (delta.length === 0) return;

    pendingScene.current = null;

    const { parts, gid } = chunkElements(delta, MAX_BROADCAST_BYTES);
    for (const [index, part] of parts.entries()) {
      const result = await channel.send({
        type: "broadcast",
        event: BoardEvent.SCENE,
        payload: {
          from: peerId,
          v: PROTOCOL_VERSION,
          elements: part,
          ...(parts.length > 1 ? { chunk: { gid, i: index, n: parts.length } } : {}),
        },
      });

      if (result !== "ok") {
        // Requeue what did not land and stop. Nothing in this chunk is marked,
        // so the next flush offers it again rather than assuming it arrived.
        pendingScene.current = next;
        sceneTimer.current = setTimeout(() => void flushSceneRef.current(), OFFLINE_RETRY_MS);
        return;
      }

      // Only now is it true that a peer has been given these.
      for (const el of part) sent.set(el.id, el.version);
    }
  }, [peerId]);
  flushSceneRef.current = flushScene;

  const publishScene = useCallback(
    (elements: readonly SyncElement[]) => {
      // Cheap reject first: Excalidraw fires onChange on pointer moves and
      // selection changes too, and most of those mutate nothing.
      const fingerprint = sceneFingerprint(elements);
      if (fingerprint === lastFingerprint.current) return;
      lastFingerprint.current = fingerprint;

      /**
       * This used to be `elements.slice(0, MAX_ELEMENTS_PER_BOARD)`, which is a
       * safety valve pointed at the user's own work.
       *
       * The truncated list went to two places. As the merge base it meant every
       * element past the ceiling stopped syncing, so peers quietly held
       * different boards. As the argument to `snapshots.mark` it was far worse:
       * the persister writes what it is given, so the next save replaced the
       * stored scene with the cut-down one and the remainder was gone from the
       * database permanently. No warning, no error, and undo cannot reach across
       * a save.
       *
       * Nothing downstream needed the cut. `save_board_snapshot` takes jsonb and
       * has no element limit of its own, and outgoing frames are already bounded
       * by `chunkElements`, on bytes and on count, which is where a real wire
       * limit belongs. So the ceiling stays a threshold to report at rather than
       * one to cut at: the board is unusual above it and worth saying so, but
       * that is the user's call to make, and dropping their shapes to make the
       * number smaller is not a fix for anything.
       */
      sceneRef.current = elements;
      pendingScene.current = elements;
      /**
       * A withheld remote update replays on the next inbound message, and if the
       * peer who sent it has since gone quiet there is no next inbound message.
       * The gesture ending is a local event, so the drain has to be driven from
       * this side too. Cheap on the hot path: the map is empty on every board
       * where two people are not touching the same shape at the same moment,
       * and the timer coalesces the ~30 calls a second a drag produces into one.
       *
       * Out of band rather than inline, because applying a remote batch calls
       * back into updateScene, which fires onChange, which lands back here.
       */
      if (deferredRemote.current.size > 0 && drainTimer.current === null) {
        drainTimer.current = setTimeout(() => {
          drainTimer.current = null;
          if (deferredRemote.current.size > 0) applyRemoteRef.current([]);
        }, 0);
      }

      const over = elements.length > MAX_ELEMENTS_PER_BOARD;
      if (over !== overCapacity.current) {
        overCapacity.current = over;
        setAtCapacity(over);
      }
      if (isWriterRef.current) snapshots.mark(elements);

      if (sceneTimer.current === null) {
        sceneTimer.current = setTimeout(() => void flushScene(), SCENE_FLUSH_INTERVAL_MS);
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
      // Presence updates make every other peer rebuild its roster and re-render,
      // so a viewer waving a mouse at the editor interval cost the whole board
      // 20 roster rebuilds a second. A cursor is worth far less than that.
      const now = Date.now();
      if (now - lastViewerTrack.current < VIEWER_CURSOR_INTERVAL_MS) return;
      lastViewerTrack.current = now;
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
    await flushScene();
    // Gated on the writer, like mark() already is. flush is reachable from
    // visibilitychange, effect cleanup and the Save now menu item, so without
    // this any peer could overwrite the whole board simply by closing its tab,
    // using whatever scene that tab happened to hold.
    if (isWriterRef.current) await snapshots.flush(sceneRef.current);
  }, [flushScene, snapshots]);

  /* ---------------------------------------------------------------- */
  /* inbound                                                           */
  /* ---------------------------------------------------------------- */

  const applyRemote = useCallback((incoming: SyncElement[]) => {
    if (incoming.length === 0 && deferredRemote.current.size === 0) return;

    // Anything withheld by an earlier gesture rides along with this batch. It
    // goes first so a genuinely newer update in `incoming` still wins on
    // version, which is the ordering reconcile applies either way.
    const batch =
      deferredRemote.current.size > 0
        ? [...deferredRemote.current.values(), ...incoming]
        : incoming;
    deferredRemote.current.clear();

    // The canvas, not the ref, whenever the canvas can be asked.
    const base = liveRef.current?.() ?? sceneRef.current;
    const { elements, changed, deferred } = reconcile(base, batch, {
      localHeldIds: heldRef.current?.(),
    });

    /**
     * Still held: keep it for the next pass rather than losing it.
     *
     * The sender has already crossed these off its own delta and will not offer
     * them again, so dropping one here loses a peer's edit permanently. Keyed by
     * id and resolved on version, because a long drag can outlast several
     * updates to the same shape and only the newest is worth replaying.
     */
    for (const el of deferred) {
      const held = deferredRemote.current.get(el.id);
      if (!held || el.version > held.version) deferredRemote.current.set(el.id, el);
    }

    if (changed.length === 0) return;

    sceneRef.current = elements;
    if (isWriterRef.current) snapshots.mark(elements);
    onRemoteRef.current(elements, changed);

    // Fingerprint and sent-versions are recorded AFTER the apply, not before.
    // updateScene runs syncInvalidIndices synchronously, which bumps version and
    // versionNonce in place on the very objects recorded here whenever incoming
    // fractional indices disagree with local z-order. Recorded first, those
    // numbers were already stale by the time the call returned, so the next
    // onChange saw a changed fingerprint and rebroadcast the peer's own elements
    // at a bumped version. Traffic doubled and z-order flapped between tabs.
    lastFingerprint.current = sceneFingerprint(sceneRef.current);
    /**
     * Remote elements are already accounted for as "sent": echoing them back to
     * the peer that authored them would loop forever.
     *
     * Only the ones that were actually applied, though. This used to run over
     * the whole incoming batch, which included the elements reconcile had just
     * withheld for being mid-gesture, and marking those as delivered was the
     * second half of losing them. The local scene still holds the user's own
     * version, so the next delta compares that version against a number the
     * peer supplied: if the peer's is the higher of the two, and after a few
     * edits on their side it usually is, the user's finished drag matches as
     * already-sent and never leaves this tab.
     */
    const withheld = new Set(deferred.map((el) => el.id));
    for (const el of batch) {
      if (!withheld.has(el.id)) sentVersions.current.set(el.id, el.version);
    }
  }, [snapshots]);
  applyRemoteRef.current = applyRemote;

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

        // Presence sync fires for cursor movement too, and the roster is
        // usually identical. Comparing a cheap key first turns a re-render per
        // cursor frame into a re-render per join or leave.
        const key = roster
          .map((p) => `${p.peerId}:${p.role}:${p.name}`)
          .sort()
          .join("|");
        if (key !== rosterKey.current) {
          rosterKey.current = key;
          setPeers(roster);
        }

        const live = new Set(roster.map((p) => p.peerId));
        // "X is generating a diagram…" used to stick for the rest of the session
        // if X closed the tab mid-run, because only X could clear it.
        setPeerActivity((previous) =>
          previous && !live.has(previous.peerId) ? null : previous,
        );
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
          // Forget what was delivered before this connection. Anything drawn
          // during an outage is still in the local scene but was never sent,
          // and an id already recorded would never be offered again. Clearing
          // re-offers the whole scene; reconcile drops the duplicates on the
          // receiving side, which is cheaper than losing the work.
          sentVersions.current.clear();
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
      if (drainTimer.current) clearTimeout(drainTimer.current);
      /**
       * Best-effort final save, and only from the writer.
       *
       * The gate was on flush() but not here, which is backwards: this is the
       * closing-a-tab path, and closing a tab is precisely how a peer that has
       * been idle for an hour gets to overwrite the board with the stale scene
       * it happens to be holding. Cannot be awaited during teardown, but with
       * the gate in place the peer that skips it is by definition not the one
       * responsible for persisting, and whoever is will persist anyway.
       */
      if (isWriterRef.current) void snapshots.flush(sceneRef.current);
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
    generation,
  ]);

  const reconnect = useCallback(() => {
    setStatus("connecting");
    setGeneration((n) => n + 1);
  }, []);

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
    atCapacity,
    peerId,
    publishScene,
    publishCursor,
    announceAi,
    flush,
    reconnect,
  };
}
