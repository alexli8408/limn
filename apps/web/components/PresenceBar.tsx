"use client";

import { useEffect, useState } from "react";
import type { ConnectionStatus, PeerState, Role } from "@limn/protocol";
import type { BeautifyStats } from "@/lib/beautify/useStrokeBeautify";

interface Props {
  title: string;
  status: ConnectionStatus;
  peers: PeerState[];
  isWriter: boolean;
  savedVersion: number;
  lastSavedAt: number | null;
  onShare: () => void;
  role: Role;
  beautifyOn: boolean;
  onToggleBeautify: () => void;
  beautifyStats: BeautifyStats;
}

/**
 * Status colours come from the theme, not from Tailwind's palette.
 *
 * theme.css defines --ink-good, --ink-warn and --ink-bad for exactly this, and
 * the raw emerald/amber/red were the only colours on the board that belonged to
 * no palette. The offline dot uses --ink-faint rather than a neutral grey, so it
 * keeps the blue cast the rest of the neutrals have.
 */
const STATUS_LABEL: Record<ConnectionStatus, { text: string; tone: string }> = {
  connecting: { text: "Connecting", tone: "bg-[var(--ink-warn)]" },
  connected: { text: "Live", tone: "bg-[var(--ink-good)]" },
  reconnecting: { text: "Reconnecting", tone: "bg-[var(--ink-warn)]" },
  offline: { text: "Offline", tone: "bg-[var(--ink-faint)]" },
  error: { text: "Error", tone: "bg-[var(--ink-bad)]" },
};

function relative(at: number | null): string {
  if (!at) return "not yet saved";
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 3) return "saved just now";
  if (seconds < 60) return `saved ${seconds}s ago`;
  return `saved ${Math.round(seconds / 60)}m ago`;
}

export default function PresenceBar(props: Props) {
  const [, tick] = useState(0);

  // Re-render on a timer so "saved 12s ago" does not sit stale until the next
  // unrelated state change.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, []);

  const status = STATUS_LABEL[props.status];
  const accuracy =
    props.beautifyStats.attempted > 0
      ? Math.round((props.beautifyStats.replaced / props.beautifyStats.attempted) * 100)
      : null;

  return (
    <header className="z-20 flex h-12 shrink-0 items-center gap-3 border-b border-[var(--ink-line)] bg-[var(--ink-surface)] px-3">
      <a
        href="/dashboard"
        className="shrink-0 font-mono text-sm font-bold uppercase tracking-[0.14em] text-[var(--ink-text)]"
      >
        limn
      </a>

      <span className="truncate text-sm text-[var(--ink-dim)]">
        {props.title}
      </span>

      {/* aria-live so the one piece of state that actually matters is announced
          rather than only being visible, and the writer explanation is real text
          rather than a title attribute no keyboard or screen reader user reaches. */}
      <span
        aria-live="polite"
        className="flex items-center gap-1.5 rounded-sm border border-[var(--ink-line)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-dim)]"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${status.tone}`} aria-hidden />
        {status.text}
        <span className="sr-only">
          .{" "}
          {props.isWriter
            ? "This tab is saving the board."
            : "Another tab is saving the board."}
        </span>
      </span>

      <span className="hidden font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)] sm:inline">
        v{props.savedVersion} · {relative(props.lastSavedAt)}
      </span>

      <div className="ml-auto flex items-center gap-2">
        {props.role !== "viewer" && (
          <button
            type="button"
            onClick={props.onToggleBeautify}
            className={`rounded-sm px-2.5 py-1 text-xs font-medium transition ${
              props.beautifyOn
                ? "bg-[var(--ink-accent)] text-[#0b0813]"
                : "border border-[var(--ink-line)] text-[var(--ink-faint)] hover:text-[var(--ink-dim)]"
            }`}
            title={
              accuracy === null
                ? "Snap freehand strokes to clean shapes as you draw"
                : `${props.beautifyStats.replaced}/${props.beautifyStats.attempted} strokes snapped (${accuracy}%)`
            }
          >
            Snap {props.beautifyOn ? "on" : "off"}
            {props.beautifyStats.replaced > 0 && (
              <span className="ml-1 opacity-60">{props.beautifyStats.replaced}</span>
            )}
          </button>
        )}

        <div className="flex items-center -space-x-1.5">
          {props.peers.slice(0, 6).map((peer) => (
            <span
              key={peer.peerId}
              title={`${peer.name}${peer.guest ? " (guest)" : ""} · ${peer.role}`}
              className="grid h-6 w-6 place-items-center rounded-full border-2 border-[var(--ink-surface)] text-[10px] font-semibold text-white"
              style={{ backgroundColor: peer.color }}
            >
              {peer.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
          {props.peers.length > 6 && (
            <span className="grid h-6 w-6 place-items-center rounded-full border-2 border-[var(--ink-surface)] bg-[var(--ink-line-bright)] text-[10px] font-semibold text-white">
              +{props.peers.length - 6}
            </span>
          )}
        </div>

        {/* A viewer cannot invite anyone, and handing them the dialog also
            handed them a working editor link. */}
        {props.role !== "viewer" && (
          <button
            type="button"
            onClick={props.onShare}
            className="rounded-sm bg-[var(--ink-accent)] px-2.5 py-1 text-xs font-semibold text-[#0b0813] transition hover:bg-[var(--ink-accent-hot)]"
          >
            Share
          </button>
        )}
      </div>
    </header>
  );
}
