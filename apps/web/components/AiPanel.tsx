"use client";

import { useEffect, useRef, useState } from "react";

/**
 * What a finished run has to show for itself.
 *
 * Two shapes, because there are two things Beautify can do and they do not
 * share a vocabulary. Rebuilding a diagram produces nodes and edges. Polishing a
 * drawing produces neither, on purpose: it keeps the shapes that were drawn and
 * lines them up, which is why a tidied house used to report "3 nodes · 0 edges"
 * from a path that never made a node.
 */
export type AiStats =
  | {
      kind: "diagram";
      nodes: number;
      edges: number;
      aligned: number;
      latencyMs: number;
      model: string;
    }
  | {
      kind: "drawing";
      groups: number;
      shapes: number;
      latencyMs: number;
      model: string;
    };

export interface AiRun {
  state: "running" | "done" | "error" | "declined";
  message: string;
  /**
   * The second line, under the message.
   *
   * A decline puts what would work instead here. A polish that moved nothing
   * puts the model's own words here, where they read as what it saw rather than
   * as work it did.
   */
  hint?: string;
  /** When the run started, so the panel can show elapsed time honestly. */
  startedAt?: number;
  stats?: AiStats;
}

/** "1 shape", "2 shapes". A count with the wrong noun reads as a bug. */
function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/**
 * The headline for a polish that moved something.
 *
 * Lives here rather than on the board because it is panel copy, and because it
 * is the sentence the counts have to agree with: "Tidied 1 shapes across 1
 * groups" was wrong twice in the one line.
 */
export function tidiedSummary(shapes: number, groups: number): string {
  return `Tidied ${count(shapes, "shape")} across ${count(groups, "group")}.`;
}

/**
 * The run's own numbers, in the words of whichever path produced them.
 *
 * Both branches go through count(). The diagram line used to hard-code its
 * plurals, and two boxes with one arrow between them is the smallest thing
 * anyone demos: it read "2 nodes · 1 edges". "aligned" is not a noun here, so it
 * takes no s and is left out entirely when nothing was.
 */
export function statsLine(stats: AiStats): string {
  const tail = `${stats.latencyMs}ms · ${stats.model}`;
  if (stats.kind === "drawing") {
    return `${count(stats.groups, "group")} · ${count(stats.shapes, "shape")} · ${tail}`;
  }
  const aligned = stats.aligned > 0 ? `${stats.aligned} aligned · ` : "";
  return `${count(stats.nodes, "node")} · ${count(stats.edges, "edge")} · ${aligned}${tail}`;
}

interface Props {
  run: AiRun | null;
  onDismiss: () => void;
  onCancel: () => void;
  /**
   * Takes no arguments on purpose.
   *
   * It used to accept an optional instruction and a quality flag, which meant
   * the primary action of the app opened a form: a field to read, a checkbox to
   * weigh up, and only then a button. Both were things the app can decide
   * better than someone can mid-sketch, and neither earned the hesitation.
   */
  onBeautify: () => Promise<void>;
  onPrompt: (prompt: string) => Promise<void>;
  onVectorize: (file: File) => Promise<void>;
  onRewrite: () => Promise<void>;
}

/**
 * Shared button skins.
 *
 * The disabled state is not `opacity-40` on the accent fill: #0b0813 text on a
 * 40% #7c5cff ground lands near 1.3:1, and the Describe tab opens disabled, so
 * the first thing a user saw was an unreadable button. Disabled now changes the
 * surface instead of fading it.
 */
const ACTION =
  "w-full rounded-sm px-3 py-2 text-xs font-semibold transition " +
  "bg-[var(--ink-accent)] text-[#0b0813] hover:bg-[var(--ink-accent-hot)] " +
  "disabled:bg-[var(--ink-raised)] disabled:text-[var(--ink-faint)] disabled:cursor-not-allowed";

const FIELD =
  "w-full rounded-sm border border-[var(--ink-line)] bg-[var(--ink-void)] px-2.5 py-1.5 " +
  "text-sm text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)] " +
  "focus-visible:border-[var(--ink-accent)] focus-visible:ring-1 focus-visible:ring-[var(--ink-accent)]";

/** Live seconds counter, so an 8 second wait reads as progress and not a hang. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  return <>{((now - since) / 1000).toFixed(1)}s</>;
}

function RunBox({
  run,
  onDismiss,
  onCancel,
}: {
  run: AiRun;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  const tone =
    run.state === "error"
      ? "border-[var(--ink-bad)]/40 bg-[var(--ink-bad)]/10 text-[var(--ink-bad)]"
      : run.state === "running"
        ? "border-[var(--ink-line)] text-[var(--ink-dim)]"
        : run.state === "declined"
          ? "border-[var(--ink-warn)]/40 bg-[var(--ink-warn)]/10 text-[var(--ink-warn)]"
          : "border-[var(--ink-good)]/40 bg-[var(--ink-good)]/10 text-[var(--ink-good)]";

  return (
    <div className={`rounded-sm border px-2.5 py-2 text-xs ${tone}`} role="status" aria-live="polite">
      <div className="flex items-start gap-2">
        {run.state === "running" && (
          <span
            aria-hidden
            className="mt-0.5 h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current/25 border-t-current"
          />
        )}
        <span className="flex-1 leading-relaxed">{run.message}</span>
        {run.state !== "running" && (
          <button
            type="button"
            onClick={onDismiss}
            className="opacity-50 transition hover:opacity-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>

      {run.state === "running" && (
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] tabular-nums opacity-70">
            {run.startedAt ? <Elapsed since={run.startedAt} /> : "working"}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm border border-[var(--ink-line-bright)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-dim)] transition hover:border-[var(--ink-bad)] hover:text-[var(--ink-bad)]"
          >
            Cancel
          </button>
        </div>
      )}

      {run.hint && <p className="mt-1.5 leading-relaxed opacity-80">{run.hint}</p>}

      {run.stats && (
        <div className="mt-1.5 font-mono text-[10px] tabular-nums opacity-70">
          {statsLine(run.stats)}
        </div>
      )}
    </div>
  );
}

/**
 * One secondary action: what it is called, and a line on what it does.
 *
 * The detail line is not decoration. Each of these spends an API call and
 * changes the board, and a name on its own ("From a photo") does not tell
 * anyone what they are about to get back.
 */
function Row({
  label,
  detail,
  disabled,
  onClick,
  expanded,
}: {
  label: string;
  detail: string;
  disabled: boolean;
  onClick: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-expanded={expanded}
      className="w-full rounded-sm px-2 py-1.5 text-left transition hover:bg-[var(--ink-raised)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="block text-xs font-medium text-[var(--ink-text)]">{label}</span>
      <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--ink-faint)]">
        {detail}
      </span>
    </button>
  );
}

export default function AiPanel(props: Props) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [describing, setDescribing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = props.run?.state === "running";

  // Escape closes, the way every other dismissable surface on the web does.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Excalidraw owns the bottom-right corner: its help button is 36px square and
  // 16px in from each edge. Clearing that whole corner keeps both the launcher
  // and the open panel off it. The width is capped against the viewport so the
  // panel does not run off the side of a phone.
  const anchor =
    "absolute bottom-16 right-5 z-20 w-[min(22rem,calc(100vw-2.5rem))] max-sm:bottom-24";

  if (!open) {
    return (
      <div className={`${anchor} flex flex-col items-end gap-2`}>
        {/* A run that settles while the panel is shut is still reported. Without
            this a decline looked exactly like the button doing nothing. */}
        {props.run && (
          <div className="w-full">
            <RunBox run={props.run} onDismiss={props.onDismiss} onCancel={props.onCancel} />
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 rounded-sm bg-[var(--ink-accent)] px-4 py-2.5 text-sm font-semibold text-[#0b0813] shadow-lg transition hover:bg-[var(--ink-accent-hot)]"
        >
          {busy ? (
            <span
              aria-hidden
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#0b0813]/30 border-t-[#0b0813]"
            />
          ) : (
            <span aria-hidden>✦</span>
          )}
          Beautify
        </button>
      </div>
    );
  }

  return (
    <div
      className={`${anchor} overflow-hidden rounded-sm border border-[var(--ink-line)] bg-[var(--ink-surface)] shadow-2xl`}
    >
      <div className="flex items-center justify-between border-b border-[var(--ink-line)] px-3 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ink-faint)]">
          Beautify
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[var(--ink-faint)] transition hover:text-[var(--ink-text)]"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* A list of what it does, not a form to fill in. Tabs used to sit here,
          and two of the three existed only to hold a text box. */}
      <div className="space-y-3 p-3">
        <p className="text-xs leading-relaxed text-[var(--ink-dim)]">
          Tidies whatever is on the board. A diagram is redrawn with square
          corners and bound arrows. A sketch keeps its own shapes and gets them
          straightened and lined up. Select part of the board to limit it.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void props.onBeautify()}
          className={ACTION}
        >
          Beautify
        </button>

        <div className="space-y-1 border-t border-[var(--ink-line)] pt-3">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void props.onVectorize(file);
              event.target.value = "";
            }}
          />
          <Row
            label="From a photo"
            detail="Traces a photographed whiteboard into shapes you can edit, and reads the handwriting back."
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          />
          <Row
            label="Fix the writing"
            detail="Corrects spelling and capitalisation in every label, or just the selected ones, and changes nothing else."
            disabled={busy}
            onClick={() => void props.onRewrite()}
          />
          <Row
            label="Draw from a description"
            detail="Say what the diagram shows and it gets built and laid out."
            disabled={busy}
            expanded={describing}
            onClick={() => setDescribing((was) => !was)}
          />
        </div>

        {describing && (
          <div className="space-y-2">
            <textarea
              autoFocus
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="A CI pipeline: commit, build, test, canary, production"
              className={`${FIELD} resize-none`}
            />
            <button
              type="button"
              disabled={busy || prompt.trim().length < 3}
              onClick={() => void props.onPrompt(prompt)}
              className={ACTION}
            >
              Draw it
            </button>
          </div>
        )}

        {props.run && (
          <RunBox run={props.run} onDismiss={props.onDismiss} onCancel={props.onCancel} />
        )}
      </div>
    </div>
  );
}
