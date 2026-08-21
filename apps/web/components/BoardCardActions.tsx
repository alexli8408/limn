"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

interface Props {
  boardId: string;
  boardTitle: string;
  /** "Delete" for a board you own, "Leave" for one shared with you. */
  verb: string;
  action: (formData: FormData) => Promise<void>;
}

function Submit({ verb, armed }: { verb: string; armed: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] transition ${
        armed
          ? "bg-[var(--ink-bad)]/15 text-[var(--ink-bad)]"
          : "text-[var(--ink-faint)] opacity-70 hover:text-[var(--ink-bad)] hover:opacity-100 group-hover:opacity-100"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {pending ? "Working…" : armed ? `Really ${verb.toLowerCase()}?` : verb}
    </button>
  );
}

/**
 * Destructive action on a board card, with a confirm step.
 *
 * The old control was `opacity-0 group-hover:opacity-100`. Invisible is not the
 * same as absent: it stayed hit-testable, and a phone has no hover, so every
 * card carried a live delete in its corner that nobody could see and nobody
 * could reach deliberately. It is visible at low opacity now, and the first
 * click only arms it.
 */
export default function BoardCardActions({ boardId, boardTitle, verb, action }: Props) {
  const [armed, setArmed] = useState(false);

  // Disarm on its own, so a card left half-confirmed does not stay dangerous.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!armed) {
          event.preventDefault();
          setArmed(true);
        }
      }}
    >
      <input type="hidden" name="id" value={boardId} />
      <span className="sr-only">
        {verb} {boardTitle}
      </span>
      <Submit verb={verb} armed={armed} />
    </form>
  );
}
