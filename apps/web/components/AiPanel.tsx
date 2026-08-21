"use client";

import { useEffect, useRef, useState } from "react";

export interface AiRun {
  state: "running" | "done" | "error" | "declined";
  message: string;
  /** Shown under a decline, telling the user what would work instead. */
  hint?: string;
  /** When the run started, so the panel can show elapsed time honestly. */
  startedAt?: number;
  stats?: {
    nodes: number;
    edges: number;
    aligned: number;
    latencyMs: number;
    model: string;
  };
}

interface Props {
  run: AiRun | null;
  onDismiss: () => void;
  onCancel: () => void;
  onBeautify: (instruction?: string, quality?: "fast" | "high") => Promise<void>;
  onPrompt: (prompt: string, quality?: "fast" | "high") => Promise<void>;
  onVectorize: (file: File) => Promise<void>;
}

type Tab = "cleanup" | "describe" | "photo";

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
          {run.stats.nodes} nodes · {run.stats.edges} edges
          {run.stats.aligned > 0 && ` · ${run.stats.aligned} aligned`} ·{" "}
          {run.stats.latencyMs}ms · {run.stats.model}
        </div>
      )}
    </div>
  );
}

export default function AiPanel(props: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("cleanup");
  const [instruction, setInstruction] = useState("");
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<"fast" | "high">("fast");
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
          Clean up
        </button>
      </div>
    );
  }

  return (
    <div
      className={`${anchor} overflow-hidden rounded-sm border border-[var(--ink-line)] bg-[var(--ink-surface)] shadow-2xl`}
    >
      <div className="flex items-center border-b border-[var(--ink-line)]" role="tablist">
        {(
          [
            ["cleanup", "Clean up"],
            ["describe", "Describe"],
            ["photo", "From photo"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`flex-1 px-3 py-2.5 text-xs font-medium transition ${
              tab === key
                ? "border-b-2 border-[var(--ink-accent)] text-[var(--ink-text)]"
                : "text-[var(--ink-faint)] hover:text-[var(--ink-dim)]"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-2.5 text-[var(--ink-faint)] transition hover:text-[var(--ink-text)]"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="space-y-3 p-3">
        {tab === "cleanup" && (
          <>
            <p className="text-xs leading-relaxed text-[var(--ink-dim)]">
              Redraws a diagram cleanly and keeps it where you put it. Select
              shapes to limit it, or select nothing to do the whole board.
            </p>
            <input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Optional: what to emphasise…"
              className={FIELD}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void props.onBeautify(instruction || undefined, quality)}
              className={ACTION}
            >
              Clean up
            </button>
          </>
        )}

        {tab === "describe" && (
          <>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="A CI pipeline: commit, build, test, canary, production…"
              className={`${FIELD} resize-none`}
            />
            <button
              type="button"
              disabled={busy || prompt.trim().length < 3}
              onClick={() => void props.onPrompt(prompt, quality)}
              className={ACTION}
            >
              Generate diagram
            </button>
          </>
        )}

        {tab === "photo" && (
          <>
            <p className="text-xs leading-relaxed text-[var(--ink-dim)]">
              Photograph a physical whiteboard. OpenCV corrects the perspective,
              traces the ink and fits real shapes you can edit.
            </p>
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
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="w-full rounded-sm border border-dashed border-[var(--ink-line-bright)] px-3 py-4 text-xs font-medium text-[var(--ink-dim)] transition hover:border-[var(--ink-accent)] disabled:cursor-not-allowed disabled:text-[var(--ink-faint)]"
            >
              Choose a photo
            </button>
          </>
        )}

        {(tab === "cleanup" || tab === "describe") && (
          <label className="flex items-center gap-2 text-[11px] text-[var(--ink-faint)]">
            <input
              type="checkbox"
              checked={quality === "high"}
              onChange={(event) => setQuality(event.target.checked ? "high" : "fast")}
              className="h-3 w-3 accent-[var(--ink-accent)]"
            />
            Higher quality (slower, thinks harder)
          </label>
        )}

        {props.run && (
          <RunBox run={props.run} onDismiss={props.onDismiss} onCancel={props.onCancel} />
        )}
      </div>
    </div>
  );
}
