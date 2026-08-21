"use client";

import type { ConnectionStatus } from "@limn/protocol";

interface Props {
  status: ConnectionStatus;
  /** Scene is past MAX_ELEMENTS_PER_BOARD. Advisory, nothing is being dropped. */
  atCapacity: boolean;
  onRetry: () => void;
}

/**
 * Says out loud when the board is not connected.
 *
 * The only signal used to be a grey dot beside the word "Offline" in a 10px
 * badge, while the canvas stayed fully editable and the footer still claimed to
 * be persisting. Someone could draw for a minute into a socket that was not
 * there and be told nothing. Drawing offline is not lost work, it is saved
 * locally and merges on reconnect, but "only on this screen" is the part they
 * need to know before they call someone over to look at it.
 *
 * Nothing renders on the calm path; the header badge covers connected and
 * connecting on its own.
 *
 * The oversized-board notice shares this slot rather than stacking a second bar
 * above the canvas. Only one of the two can be the more useful thing to read,
 * and it is always the connection: a board that is slow is still a board, and
 * being told it is large while the socket is down would bury the sentence that
 * matters.
 */
export default function ConnectionBar({ status, atCapacity, onRetry }: Props) {
  const connected = status === "connected" || status === "connecting";

  if (connected) {
    if (!atCapacity) return null;
    return (
      <div
        role="status"
        aria-live="polite"
        className="z-30 flex shrink-0 items-center gap-3 border-b border-[var(--ink-warn)]/40 bg-[var(--ink-warn)]/15 px-3 py-2 text-xs text-[var(--ink-warn)]"
      >
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[var(--ink-warn)]" />
        <span className="flex-1 leading-relaxed">
          This board is very large. Nothing has been dropped, but syncing and
          saving get slower from here. Move part of it to a second board.
        </span>
      </div>
    );
  }

  const message =
    status === "reconnecting"
      ? "Reconnecting. Anything you draw now will sync when it comes back."
      : status === "error"
        ? "Lost the connection to the board. Your changes are only on this screen."
        : "Not connected. Your changes are only on this screen.";

  const urgent = status !== "reconnecting";

  return (
    <div
      role="status"
      aria-live="assertive"
      className={`z-30 flex shrink-0 items-center gap-3 border-b px-3 py-2 text-xs ${
        urgent
          ? "border-[var(--ink-bad)]/40 bg-[var(--ink-bad)]/15 text-[var(--ink-bad)]"
          : "border-[var(--ink-warn)]/40 bg-[var(--ink-warn)]/15 text-[var(--ink-warn)]"
      }`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${
          urgent ? "bg-[var(--ink-bad)]" : "animate-pulse bg-[var(--ink-warn)]"
        }`}
      />
      <span className="flex-1 leading-relaxed">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-sm border border-current/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] transition hover:bg-current/10"
      >
        Retry
      </button>
    </div>
  );
}
