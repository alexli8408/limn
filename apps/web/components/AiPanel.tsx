"use client";

import { useRef, useState } from "react";

export interface AiRun {
  state: "running" | "done" | "error" | "declined";
  message: string;
  /** Shown under a decline, telling the user what would work instead. */
  hint?: string;
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
  onBeautify: (instruction?: string, quality?: "fast" | "high") => Promise<void>;
  onPrompt: (prompt: string, quality?: "fast" | "high") => Promise<void>;
  onVectorize: (file: File) => Promise<void>;
}

type Tab = "beautify" | "prompt" | "photo";

export default function AiPanel(props: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("beautify");
  const [instruction, setInstruction] = useState("");
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<"fast" | "high">("fast");
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = props.run?.state === "running";

  // Excalidraw owns the bottom-right corner: its help button sits 16px in from
  // each edge and is 36px square. Anchoring here at bottom-5 put this button
  // straight on top of it. Clearing the whole 52px that corner occupies, rather
  // than nudging sideways, keeps the panel clear of it too once it opens.
  const anchor = "absolute bottom-16 right-5 z-20";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${anchor} flex items-center gap-2 rounded-sm bg-[var(--ink-accent)] px-4 py-2.5 text-sm font-semibold text-[#0b0813] shadow-lg transition hover:bg-[var(--ink-accent-hot)]`}
      >
        {busy ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        ) : (
          <span aria-hidden>✦</span>
        )}
        Beautify
      </button>
    );
  }

  return (
    <div className={`${anchor} w-[22rem] overflow-hidden rounded-sm border border-[var(--ink-line)] bg-[var(--ink-surface)] shadow-2xl`}>
      <div className="flex items-center border-b border-[var(--ink-line)]">
        {(
          [
            ["beautify", "Clean up"],
            ["prompt", "Describe"],
            ["photo", "From photo"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
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
          className="px-3 py-2.5 text-[var(--ink-faint)] hover:text-[var(--ink-text)]"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="space-y-3 p-3">
        {tab === "beautify" && (
          <>
            <p className="text-xs leading-relaxed text-[var(--ink-dim)]">
              Redraws a diagram cleanly and keeps it where you put it. Select
              shapes to limit it, or select nothing to do the whole board.
            </p>
            <input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Optional: what to emphasise…"
              className="w-full rounded-sm border border-[var(--ink-line)] bg-[var(--ink-void)] px-2.5 py-1.5 text-sm text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--ink-accent)]"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void props.onBeautify(instruction || undefined, quality)}
              className="w-full rounded-sm bg-[var(--ink-accent)] px-3 py-2 text-xs font-semibold text-[#0b0813] transition hover:bg-[var(--ink-accent-hot)] disabled:opacity-40"
            >
              Clean it up
            </button>
          </>
        )}

        {tab === "prompt" && (
          <>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="A CI pipeline: commit, build, test, canary, production…"
              className="w-full resize-none rounded-sm border border-[var(--ink-line)] bg-[var(--ink-void)] px-2.5 py-1.5 text-sm text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--ink-accent)]"
            />
            <button
              type="button"
              disabled={busy || prompt.trim().length < 3}
              onClick={() => void props.onPrompt(prompt, quality)}
              className="w-full rounded-sm bg-[var(--ink-accent)] px-3 py-2 text-xs font-semibold text-[#0b0813] transition hover:bg-[var(--ink-accent-hot)] disabled:opacity-40"
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
              className="w-full rounded-sm border border-dashed border-[var(--ink-line-bright)] px-3 py-4 text-xs font-medium text-[var(--ink-dim)] transition hover:border-[var(--ink-accent)] disabled:opacity-40"
            >
              Choose a photo
            </button>
          </>
        )}

        {(tab === "beautify" || tab === "prompt") && (
        <label className="flex items-center gap-2 text-[11px] text-[var(--ink-faint)]">
          <input
            type="checkbox"
            checked={quality === "high"}
            onChange={(event) => setQuality(event.target.checked ? "high" : "fast")}
            className="h-3 w-3"
          />
          Higher quality (slower, uses a stronger model)
        </label>
        )}

        {props.run && (
          <div
            className={`rounded-sm px-2.5 py-2 text-xs ${
              props.run.state === "error"
                ? "border border-[var(--ink-bad)]/40 bg-[var(--ink-bad)]/10 text-[var(--ink-bad)]"
                : props.run.state === "running"
                  ? "border border-[var(--ink-line)] text-[var(--ink-dim)]"
                  : props.run.state === "declined"
                    ? "border border-[var(--ink-warn)]/40 bg-[var(--ink-warn)]/10 text-[var(--ink-warn)]"
                    : "border border-[var(--ink-good)]/40 bg-[var(--ink-good)]/10 text-[var(--ink-good)]"
            }`}
          >
            <div className="flex items-start gap-2">
              <span className="flex-1 leading-relaxed">{props.run.message}</span>
              {props.run.state !== "running" && (
                <button
                  type="button"
                  onClick={props.onDismiss}
                  className="opacity-50 hover:opacity-100"
                  aria-label="Dismiss"
                >
                  ×
                </button>
              )}
            </div>
            {props.run.hint && (
              <p className="mt-1.5 leading-relaxed opacity-80">{props.run.hint}</p>
            )}
            {props.run.stats && (
              <div className="mt-1.5 font-mono text-[10px] opacity-70">
                {props.run.stats.nodes} nodes · {props.run.stats.edges} edges
                {props.run.stats.aligned > 0 && ` · ${props.run.stats.aligned} aligned`} ·{" "}
                {props.run.stats.latencyMs}ms · {props.run.stats.model}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
