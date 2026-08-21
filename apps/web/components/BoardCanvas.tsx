"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  Excalidraw,
  CaptureUpdateAction,
  Footer,
  MainMenu,
  convertToExcalidrawElements,
  exportToBlob,
  getSceneVersion,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { Role, SyncElement } from "@limn/protocol";
import { useCollab } from "@/lib/collab/useCollab";
import { useBoardThumbnail } from "@/lib/board/useBoardThumbnail";
import { useStrokeBeautify } from "@/lib/beautify/useStrokeBeautify";
import { compileDiagram, inkOf, tombstone } from "@/lib/ai/compile";
import { autoTitleBoard } from "@/app/actions";
import type { LimnDiagram } from "@/lib/ai/schema";
import RemoteCursors from "./RemoteCursors";
import PresenceBar from "./PresenceBar";
import ShareDialog from "./ShareDialog";
import AiPanel, { type AiRun } from "./AiPanel";
import ConnectionBar from "./ConnectionBar";
import FirstRunHint from "./FirstRunHint";
import "@excalidraw/excalidraw/index.css";

// Imported directly rather than via next/dynamic: BoardCanvasLoader already
// keeps this whole module off the server, so a second ssr:false boundary here
// would only add a render pass.

export interface BoardCanvasProps {
  boardId: string;
  title: string;
  userId: string;
  displayName: string;
  role: Role;
  guest: boolean;
  avatarUrl?: string;
  initialElements: SyncElement[];
  initialVersion: number;
  shareUrl: string;
  ownerId: string;
  linkRole: Role;
  visibility: "private" | "link" | "public";
}

/** Stable empty set, so getHeldIds does not allocate on every remote frame. */
const EMPTY_HELD: ReadonlySet<string> = new Set();

/**
 * Hoisted out of the render.
 *
 * Excalidraw memoises itself on its props, and an object literal written inline
 * is a new reference every render, so this alone was enough to make that memo
 * never hit. With a remote cursor moving at 20 frames a second, the entire
 * canvas subtree was re-rendering 20 times a second for no reason.
 */
const UI_OPTIONS = { canvasActions: { toggleTheme: true, loadScene: false } } as const;

export default function BoardCanvas(props: BoardCanvasProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [beautifyOn, setBeautifyOn] = useState(true);
  const [aiRun, setAiRun] = useState<AiRun | null>(null);
  const [sharing, setSharing] = useState(false);
  // The hint is for an empty board only, and the first stroke retires it.
  const [showHint, setShowHint] = useState(
    () => props.initialElements.filter((el) => !el.isDeleted).length === 0,
  );
  // Shown in the header. Starts as whatever the server rendered and is replaced
  // when the AI names an untitled board, so the change is visible immediately
  // rather than only after a reload.
  const [title, setTitle] = useState(props.title);

  /**
   * Names the board from what the model recognised, once, while it is still
   * untitled. The server action is the real guard; this only avoids a pointless
   * round trip and keeps the header in step.
   */
  const applyAiTitle = useCallback(
    (suggested: string | undefined) => {
      const clean = (suggested ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (!clean || title !== "Untitled board") return;
      setTitle(clean);
      void autoTitleBoard(props.boardId, clean).catch(() => setTitle(props.title));
    },
    [title, props.boardId, props.title],
  );

  const readOnly = props.role === "viewer";
  /** Read only from the Save now menu item, so it stays out of the memo deps. */
  const flushRef = useRef<() => Promise<void>>(async () => {});

  // Guards re-entry: applying a remote update triggers onChange, which would
  // otherwise be published straight back out as a local edit.
  const applyingRemote = useRef(false);
  /** True between pointer down and pointer up, so a drag can be protected. */
  const pointerDown = useRef(false);
  /** Aborts the AI request in flight, so Cancel actually stops the wait. */
  const aiAbort = useRef<AbortController | null>(null);
  const lastLocalVersion = useRef(-1);

  const onRemoteScene = useCallback(
    (elements: SyncElement[]) => {
      if (!api) return;
      applyingRemote.current = true;
      try {
        api.updateScene({
          elements: elements as never,
          // Remote work is not the local user's to undo. Capturing it would put
          // someone else's edits on this tab's undo stack.
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } finally {
        applyingRemote.current = false;
      }
    },
    [api],
  );

  // Deleted elements included: they are tombstones, and dropping them from the
  // merge base would resurrect anything a peer had already deleted.
  const getLiveElements = useCallback(
    () =>
      (api?.getSceneElementsIncludingDeleted() as unknown as SyncElement[]) ??
      props.initialElements,
    [api, props.initialElements],
  );

  /**
   * What the user has hold of right now.
   *
   * Only while the pointer is down: a selection sitting idle should still take
   * a peer's update, it is only an in-progress gesture that must not have the
   * object swapped underneath it.
   */
  const getHeldIds = useCallback((): ReadonlySet<string> => {
    if (!api || !pointerDown.current) return EMPTY_HELD;
    return new Set(Object.keys(api.getAppState().selectedElementIds ?? {}));
  }, [api]);

  const collab = useCollab({
    boardId: props.boardId,
    userId: props.userId,
    displayName: props.displayName,
    role: props.role,
    guest: props.guest,
    avatarUrl: props.avatarUrl,
    initialElements: props.initialElements,
    initialVersion: props.initialVersion,
    onRemoteScene,
    getLiveElements,
    getHeldIds,
  });

  // useCollab returns a fresh object each render, so anything depending on
  // `collab` wholesale is rebuilt every render even though these functions are
  // individually stable.
  const { publishScene, publishCursor, announceAi, isWriter, savedVersion } = collab;

  /** Applies a locally produced scene and publishes it in one step. */
  const commit = useCallback(
    (next: SyncElement[], undoable = true) => {
      if (!api) return;
      applyingRemote.current = true;
      try {
        api.updateScene({
          elements: next as never,
          captureUpdate: undoable
            ? CaptureUpdateAction.IMMEDIATELY
            : CaptureUpdateAction.NEVER,
        });
      } finally {
        applyingRemote.current = false;
      }
      publishScene(next);
    },
    [api, publishScene],
  );

  flushRef.current = collab.flush;

  useBoardThumbnail({
    boardId: props.boardId,
    api,
    isWriter,
    savedVersion,
  });

  const beautify = useStrokeBeautify({
    enabled: beautifyOn && !readOnly,
    // Beautification stays undoable: someone who wanted their wobbly circle
    // should get it back with one Ctrl+Z, not have to redraw it.
    commit: (next) => commit(next, true),
  });

  const onChange = useCallback(
    (
      elements: readonly unknown[],
      appState: { newElement?: unknown },
    ) => {
      if (applyingRemote.current || readOnly) return;

      const scene = elements as readonly SyncElement[];
      const version = getSceneVersion(scene as never);
      if (version === lastLocalVersion.current) return;
      lastLocalVersion.current = version;

      if (scene.some((el) => !el.isDeleted)) setShowHint(false);
      publishScene(scene);
      beautify.onSceneChange(scene, appState);
    },
    [publishScene, beautify, readOnly],
  );

  const onPointerUpdate = useCallback(
    (payload: {
      pointer: { x: number; y: number };
      button: "up" | "down";
    }) => {
      pointerDown.current = payload.button === "down";
      publishCursor(
        payload.pointer.x,
        payload.pointer.y,
        api?.getAppState().activeTool?.type,
        payload.button,
      );
    },
    [publishCursor, api],
  );

  /* ---------------------------------------------------------------- */
  /* AI                                                                */
  /* ---------------------------------------------------------------- */

  const runBeautifyAi = useCallback(
    async (instruction?: string, quality?: "fast" | "high") => {
      if (!api || readOnly) return;

      const all = api.getSceneElements() as unknown as SyncElement[];
      const selectedIds = new Set(
        Object.keys(api.getAppState().selectedElementIds ?? {}),
      );
      // Operate on the selection if there is one, else the whole board.
      const target = selectedIds.size
        ? all.filter((el) => selectedIds.has(el.id))
        : all.filter((el) => !el.isDeleted);

      if (target.length === 0) {
        setAiRun({ state: "error", message: "Nothing to beautify, draw something first." });
        return;
      }

      aiAbort.current?.abort();
      const controller = new AbortController();
      aiAbort.current = controller;
      setAiRun({ state: "running", message: "Reading your sketch…", startedAt: Date.now() });
      announceAi("start", "refine", props.displayName);

      try {
        // The model gets a picture as well as coordinates: which arrow points at
        // which box is obvious in an image and genuinely ambiguous in numbers.
        const blob = await exportToBlob({
          elements: target as never,
          appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
          files: api.getFiles(),
          mimeType: "image/png",
          maxWidthOrHeight: 1400,
        });
        const image = await blobToBase64(blob);

        const response = await fetch("/api/ai/beautify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            boardId: props.boardId,
            elements: target.map(toSketchElement),
            image,
            instruction,
            mode: "refine",
            quality: quality ?? "fast",
          }),
          signal: controller.signal,
        });

        const payload = (await response.json()) as
          | { diagram: LimnDiagram; meta: Record<string, unknown> }
          | { error: string };

        if (!response.ok || "error" in payload) {
          throw new Error("error" in payload ? payload.error : "generation failed");
        }

        // A sketch that is not a diagram is left completely alone. Converting a
        // drawing into boxes loses the author's work and gives them something
        // they did not ask for, which is worse than doing nothing.
        if (payload.diagram.kind !== "diagram") {
          setAiRun({
            state: "declined",
            message:
              payload.diagram.rationale ||
              "That looks like a drawing rather than a diagram, so nothing was changed.",
            hint:
              payload.diagram.kind === "empty"
                ? "Draw some shapes and connect them with arrows, then try again."
                : "Clean up only redraws diagrams. For a drawing, the Snap toggle in the header tidies strokes as you draw.",
          });
          announceAi("done", "refine", props.displayName);
          return;
        }

        // Re-read the scene rather than reuse `all`, which was captured before
        // a request that takes seconds. Anything drawn in the meantime, by this
        // user or by a collaborator, is in the live scene and not in `all`, and
        // committing the stale copy silently deleted all of it.
        const current = api.getSceneElements() as unknown as SyncElement[];

        const bounds = boundsOf(target);
        const compiled = compileDiagram(payload.diagram, {
          existing: current,
          origin: bounds ? { x: bounds.x, y: bounds.y } : { x: 0, y: 0 },
          // Redraw in whatever the sketch was drawn in, so cleaning up a red
          // diagram does not hand back a black one.
          ink: inkOf(target),
        });

        if (compiled.elements.length === 0) {
          throw new Error("the model did not return anything placeable");
        }

        const next = [...tombstone(current, compiled.replacedIds), ...compiled.elements];
        commit(next, true);
        applyAiTitle(payload.diagram.title);

        setAiRun({
          state: "done",
          message: payload.diagram.rationale || "Done.",
          stats: {
            nodes: compiled.stats.nodes,
            edges: compiled.stats.edges,
            aligned: compiled.stats.aligned,
            latencyMs: Number(payload.meta.latencyMs ?? 0),
            model: String(payload.meta.model ?? ""),
          },
        });
        announceAi("done", "refine", props.displayName);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setAiRun(null);
        } else {
          setAiRun({
            state: "error",
            message: error instanceof Error ? error.message : "generation failed",
          });
        }
        announceAi("error", "refine", props.displayName);
      }
    },
    [api, readOnly, announceAi, props.boardId, props.displayName, commit, applyAiTitle],
  );

  const runPromptAi = useCallback(
    async (prompt: string, quality?: "fast" | "high") => {
      if (!api || readOnly) return;
      aiAbort.current?.abort();
      const controller = new AbortController();
      aiAbort.current = controller;
      setAiRun({ state: "running", message: "Composing a diagram…", startedAt: Date.now() });
      announceAi("start", "prompt", props.displayName);

      try {
        const response = await fetch("/api/ai/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            boardId: props.boardId,
            prompt,
            quality: quality ?? "fast",
          }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as
          | { diagram: LimnDiagram; meta: Record<string, unknown> }
          | { error: string };
        if (!response.ok || "error" in payload) {
          throw new Error("error" in payload ? payload.error : "generation failed");
        }

        const all = api.getSceneElements() as unknown as SyncElement[];
        // Place the new diagram clear of everything already on the board.
        const existing = boundsOf(all.filter((el) => !el.isDeleted));
        const origin = existing
          ? { x: existing.x, y: existing.y + existing.height + 120 }
          : { x: 120, y: 120 };

        // The prompt path never checked kind, and it matters more now that kind
        // fails closed to "drawing": a request the model declines compiles to
        // nothing, and this used to commit that nothing and report "Done." The
        // user watched a spinner for several seconds and got a success message
        // over an unchanged board.
        if (payload.diagram.kind !== "diagram" || payload.diagram.nodes.length === 0) {
          setAiRun({
            state: "declined",
            message:
              payload.diagram.rationale ||
              "That did not describe something this can draw as a diagram.",
            hint: "Describe things and how they connect, for example: commit, build, test, deploy, with a rollback from deploy.",
          });
          announceAi("done", "prompt", props.displayName);
          return;
        }

        // No source sketch to take colour from, so follow whatever the rest of
        // the board is drawn in and let a new diagram match its surroundings.
        const compiled = compileDiagram(payload.diagram, {
          existing: all,
          origin,
          ink: inkOf(all),
        });

        if (compiled.elements.length === 0) {
          throw new Error("the model did not return anything placeable");
        }

        commit([...all, ...compiled.elements], true);
        api.scrollToContent(compiled.elements as never, { fitToContent: true });
        applyAiTitle(payload.diagram.title);

        setAiRun({
          state: "done",
          message: payload.diagram.rationale || "Done.",
          stats: {
            nodes: compiled.stats.nodes,
            edges: compiled.stats.edges,
            aligned: 0,
            latencyMs: Number(payload.meta.latencyMs ?? 0),
            model: String(payload.meta.model ?? ""),
          },
        });
        announceAi("done", "prompt", props.displayName);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setAiRun(null);
        } else {
          setAiRun({
            state: "error",
            message: error instanceof Error ? error.message : "generation failed",
          });
        }
        announceAi("error", "prompt", props.displayName);
      }
    },
    [api, readOnly, announceAi, props.boardId, props.displayName, commit, applyAiTitle],
  );

  const runVectorize = useCallback(
    async (file: File) => {
      if (!api || readOnly) return;
      aiAbort.current?.abort();
      const controller = new AbortController();
      aiAbort.current = controller;
      setAiRun({
        state: "running",
        message: "Tracing the photo… (a sleeping vision instance can take ~50s)",
        startedAt: Date.now(),
      });

      try {
        const image = await blobToBase64(file);
        const response = await fetch("/api/vision/vectorize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ boardId: props.boardId, image }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as
          | {
              shapes: VisionShape[];
              traced_strokes: number;
              latency_ms: number;
              deskewed: boolean;
              source_width: number;
              source_height: number;
            }
          | { error: string };
        if (!response.ok || "error" in payload) {
          throw new Error("error" in payload ? payload.error : "vectorize failed");
        }

        const all = api.getSceneElements() as unknown as SyncElement[];
        const existing = boundsOf(all.filter((el) => !el.isDeleted));
        const origin = existing
          ? { x: existing.x + existing.width + 160, y: existing.y }
          : { x: 80, y: 80 };

        const elements = shapesToElements(payload.shapes, origin);
        if (elements.length === 0) throw new Error("no strokes found in that image");

        // The tracer sees ink, not language, so a photographed board came back
        // as unlabelled boxes and every word on it was lost. Reading the same
        // photo recovers them.
        //
        // Deliberately after the trace and deliberately not awaited into the
        // failure path: text is a bonus, and a board that traced correctly
        // should not be reported as a failure because the reading step was rate
        // limited or refused.
        const words = await readPhotoText(props.boardId, image, controller.signal);
        const labels = words.length
          ? textToElements(words, origin, payload.source_width, payload.source_height)
          : [];

        commit([...all, ...elements, ...labels], true);
        api.scrollToContent([...elements, ...labels] as never, { fitToContent: true });

        setAiRun({
          state: "done",
          message: `Traced ${payload.traced_strokes} strokes${
            labels.length ? ` and read ${labels.length} labels` : ""
          }${payload.deskewed ? " (perspective corrected)" : ""}.`,
          stats: {
            nodes: payload.shapes.filter((s) => s.kind !== "freedraw").length,
            edges: 0,
            aligned: 0,
            latencyMs: payload.latency_ms,
            model: "opencv",
          },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setAiRun(null);
        } else {
          setAiRun({
            state: "error",
            message: error instanceof Error ? error.message : "vectorize failed",
          });
        }
      }
    },
    [api, readOnly, props.boardId, commit],
  );

  const initialData = useMemo(
    () => ({
      elements: props.initialElements as never,
      appState: {
        // Light, deliberately, even though the board renders dark. Excalidraw's
        // dark theme is an inversion filter over the whole canvas, so it wants
        // light-theme colours and darkens them itself. Handing it an already
        // dark background inverted it back to light, and since element strokes
        // default to near-black and invert to near-white, a fresh board drew
        // pale strokes on a pale canvas and looked empty.
        viewBackgroundColor: "#ffffff",
        currentItemRoughness: 1,
        theme: "dark" as const,
      },
      scrollToContent: true,
    }),
    [props.initialElements],
  );

  // Memoised for the same reason as UI_OPTIONS: Excalidraw's comparator bails
  // the moment `children` differ by reference, and inline JSX differs every
  // render. These read only the writer flag and the saved version.
  const canvasChrome = useMemo(
    () => (
      <>
        <MainMenu>
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.Separator />
          <MainMenu.Item onSelect={() => void flushRef.current()}>Save now</MainMenu.Item>
        </MainMenu>
        <Footer>
          <div className="pointer-events-none px-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
            {isWriter ? "persisting" : "following"} · v{savedVersion}
          </div>
        </Footer>
      </>
    ),
    [isWriter, savedVersion],
  );

  return (
    <div className="relative flex h-dvh w-full flex-col">
      <PresenceBar
        title={title}
        status={collab.status}
        peers={collab.peers}
        isWriter={collab.isWriter}
        savedVersion={collab.savedVersion}
        lastSavedAt={collab.lastSavedAt}
        onShare={() => setSharing(true)}
        role={props.role}
        beautifyOn={beautifyOn}
        onToggleBeautify={() => setBeautifyOn((v) => !v)}
        beautifyStats={beautify.stats}
      />

      <ConnectionBar status={collab.status} onRetry={collab.reconnect} />

      {sharing && (
        <ShareDialog
          boardId={props.boardId}
          shareUrl={props.shareUrl}
          linkRole={props.linkRole}
          visibility={props.visibility}
          isOwner={props.userId === props.ownerId}
          ownerId={props.ownerId}
          onClose={() => setSharing(false)}
        />
      )}

      <div className="relative flex-1">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={initialData}
          onChange={onChange as never}
          onPointerUpdate={onPointerUpdate as never}
          theme="dark"
          viewModeEnabled={readOnly}
          UIOptions={UI_OPTIONS}
        >
          {canvasChrome}
        </Excalidraw>

        {showHint && !readOnly && <FirstRunHint />}

        <RemoteCursors cursors={collab.cursors} api={api} />

        {collab.peerActivity && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-sm border border-[var(--ink-line)] bg-[var(--ink-surface)] px-3 py-1.5 text-xs text-[var(--ink-dim)] shadow-lg">
            <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--ink-good)]" />
            {collab.peerActivity.label} is{" "}
            {collab.peerActivity.mode === "vectorize"
              ? "tracing a photo"
              : collab.peerActivity.mode === "prompt"
                ? "generating a diagram"
                : "cleaning up the sketch"}
            …
          </div>
        )}

        {!readOnly && (
          <AiPanel
            run={aiRun}
            onDismiss={() => setAiRun(null)}
            onCancel={() => {
              aiAbort.current?.abort();
              setAiRun(null);
            }}
            onBeautify={runBeautifyAi}
            onPrompt={runPromptAi}
            onVectorize={runVectorize}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

interface OcrWord {
  text: string;
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
}

/**
 * Reads the words off a photographed board.
 *
 * Never throws. The trace has already succeeded by the time this runs, and
 * losing the labels is a smaller loss than telling someone their photo failed
 * when a board full of shapes is sitting on their canvas.
 */
async function readPhotoText(
  boardId: string,
  image: string,
  signal: AbortSignal,
): Promise<OcrWord[]> {
  try {
    const response = await fetch("/api/ai/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId, image }),
      signal,
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { text?: OcrWord[] };
    // A low-confidence read is a guess at handwriting, and a wrong word placed
    // confidently on the canvas is worse than no word.
    return (payload.text ?? []).filter((item) => item.confidence >= 0.5);
  } catch {
    return [];
  }
}

/**
 * Places read words into the same space the traced shapes landed in.
 *
 * The boxes arrive normalised to the photo, and the tracer reports the pixel
 * dimensions it worked in, so the two multiply together. This is approximate
 * when the tracer deskewed the image, because the words were read from the
 * original and the shapes come from the flattened one; the alternative is
 * throwing every label away, and a label a few pixels out can be dragged.
 */
function textToElements(
  words: readonly OcrWord[],
  origin: { x: number; y: number },
  sourceWidth: number,
  sourceHeight: number,
): SyncElement[] {
  const skeletons = words.map((word) => ({
    type: "text",
    x: origin.x + word.box.x * sourceWidth,
    y: origin.y + word.box.y * sourceHeight,
    text: word.text,
    // From the box the model drew round it, so a heading stays bigger than a
    // note. Floored because Excalidraw renders anything under ~8px unreadably.
    fontSize: Math.max(12, Math.round(word.box.height * sourceHeight * 0.8)),
    strokeColor: "#1e1e1e",
  }));
  return convertToExcalidrawElements(skeletons as never) as unknown as SyncElement[];
}

interface VisionShape {
  kind: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  points?: number[][] | null;
  stroke_color?: string | null;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Chunked: String.fromCharCode(...bytes) blows the argument limit somewhere
  // around a megabyte, which a phone photo comfortably exceeds.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function toSketchElement(el: SyncElement) {
  return {
    id: el.id,
    type: String(el.type ?? "unknown"),
    x: Math.round(Number(el.x ?? 0)),
    y: Math.round(Number(el.y ?? 0)),
    width: Math.round(Number(el.width ?? 0)),
    height: Math.round(Number(el.height ?? 0)),
    ...(typeof el.text === "string" && el.text ? { text: el.text.slice(0, 400) } : {}),
    ...(typeof el.containerId === "string" ? { containerId: el.containerId } : {}),
    ...(typeof el.strokeColor === "string" ? { strokeColor: el.strokeColor } : {}),
  };
}

function boundsOf(elements: readonly SyncElement[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const x = Number(el.x);
    const y = Number(el.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + Number(el.width ?? 0));
    maxY = Math.max(maxY, y + Number(el.height ?? 0));
  }
  return Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : null;
}

/** Vision service shape specs to Excalidraw elements, offset onto the canvas. */
function shapesToElements(
  shapes: readonly VisionShape[],
  origin: { x: number; y: number },
): SyncElement[] {
  const skeletons = shapes.map((shape) => {
    const common = {
      x: origin.x + shape.x,
      y: origin.y + shape.y,
      strokeColor: shape.stroke_color ?? "#1e1e1e",
      strokeWidth: 2,
      roughness: 1,
      backgroundColor: "transparent",
    };

    if (shape.kind === "freedraw" && shape.points?.length) {
      return { type: "freedraw", ...common, points: shape.points };
    }
    if (shape.points?.length && (shape.kind === "line" || shape.kind === "arrow")) {
      return { type: shape.kind, ...common, points: shape.points };
    }
    if (shape.points?.length) {
      return { type: "line", ...common, points: shape.points };
    }
    return {
      type: shape.kind === "ellipse" || shape.kind === "diamond" ? shape.kind : "rectangle",
      ...common,
      width: Math.max(shape.width, 1),
      height: Math.max(shape.height, 1),
      angle: shape.angle,
    };
  });

  return convertToExcalidrawElements(skeletons as never) as unknown as SyncElement[];
}
