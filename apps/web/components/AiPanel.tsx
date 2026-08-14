"use client";

import { useRef, useState } from "react";

export interface AiRun {
  state: "running" | "done" | "error";
  message: string;
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
  onBeautify: (
    mode: "refine" | "recompose",
    instruction?: string,
    quality?: "fast" | "high",
  ) => Promise<void>;
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

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute bottom-5 right-5 z-20 flex items-center gap-2 rounded-full bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg transition hover:bg-neutral-700"
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
    <div className="absolute bottom-5 right-5 z-20 w-[22rem] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center border-b border-neutral-200 dark:border-neutral-800">
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
                ? "border-b-2 border-neutral-900 text-neutral-900 dark:border-neutral-100 dark:text-neutral-100"
                : "text-neutral-400 hover:text-neutral-600"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-2.5 text-neutral-400 hover:text-neutral-600"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="space-y-3 p-3">
        {tab === "beautify" && (
          <>
            <p className="text-xs leading-relaxed text-neutral-500">
              Redraws your sketch cleanly, keeping your layout. Select shapes to
              limit it, or leave nothing selected to do the whole board.
            </p>
            <input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Optional: what to emphasise…"
              className="w-full rounded-md border border-neutral-200 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void props.onBeautify("refine", instruction || undefined, quality)}
                className="flex-1 rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
              >
                Keep my layout
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void props.onBeautify("recompose", instruction || undefined, quality)
                }
                className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium disabled:opacity-50 dark:border-neutral-700"
                title="Re-lay out the diagram from scratch"
              >
                Re-arrange
              </button>
            </div>
          </>
        )}

        {tab === "prompt" && (
          <>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="A CI pipeline: commit, build, test, canary, production…"
              className="w-full resize-none rounded-md border border-neutral-200 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700"
            />
            <button
              type="button"
              disabled={busy || prompt.trim().length < 3}
              onClick={() => void props.onPrompt(prompt, quality)}
              className="w-full rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            >
              Generate diagram
            </button>
          </>
        )}

        {tab === "photo" && (
          <>
            <p className="text-xs leading-relaxed text-neutral-500">
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
              className="w-full rounded-md border border-dashed border-neutral-300 px-3 py-4 text-xs font-medium text-neutral-600 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300"
            >
              Choose a photo
            </button>
          </>
        )}

        <label className="flex items-center gap-2 text-[11px] text-neutral-500">
          <input
            type="checkbox"
            checked={quality === "high"}
            onChange={(event) => setQuality(event.target.checked ? "high" : "fast")}
            className="h-3 w-3"
          />
          Higher quality (slower, uses the Pro model)
        </label>

        {props.run && (
          <div
            className={`rounded-md px-2.5 py-2 text-xs ${
              props.run.state === "error"
                ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                : props.run.state === "running"
                  ? "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  : "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
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
