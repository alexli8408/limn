"use client";

import { useFormStatus } from "react-dom";

interface Props {
  children: React.ReactNode;
  /** Shown while the surrounding form action is in flight. */
  pendingLabel: string;
  className?: string;
}

/**
 * A submit button that admits it is working.
 *
 * Creating a board is an RPC, a redirect, four sequential Supabase round trips
 * and a dynamically imported Excalidraw chunk, so the plain submit it replaces
 * sat there looking dead for several seconds. People click a dead button again,
 * and startDrawing has no idempotency, so the second click made a second board.
 *
 * useFormStatus only reads the form it is rendered inside, which is why this has
 * to be its own client component rather than a prop on the page.
 */
export default function PendingButton({ children, pendingLabel, className }: Props) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
