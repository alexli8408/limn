"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Route-level error boundary.
 *
 * Every `throw new Error` in a server action landed on Next's stock
 * "Application error: a server-side exception has occurred", which tells a user
 * nothing and does not even offer a way out. This keeps them inside the product
 * and gives them the two things that actually help: try again, or go somewhere
 * that works.
 *
 * The digest is shown deliberately. It is the only handle on a server error
 * whose message Next strips in production, so a user reporting a problem can
 * quote something that identifies it in the logs.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[limn]", error);
  }, [error]);

  return (
    <div className="landing min-h-screen">
      <div className="paper" aria-hidden />
      <div className="shell relative flex min-h-screen flex-col">
        <header className="bar">
          <Link href="/" className="mark text-[var(--ink-text)] no-underline">
            limn
          </Link>
        </header>
        <hr className="rule" />

        <main className="flex flex-1 items-center">
          <div className="max-w-lg py-16">
            <p className="eyebrow">that did not work</p>
            <h1 className="title text-balance">
              Something broke on our side,{" "}
              <span className="text-[var(--ink-accent)]">not yours.</span>
            </h1>
            <p className="mb-8 text-sm leading-relaxed text-[var(--ink-dim)]">
              Your boards are stored in Postgres and are not affected by this.
              Trying again usually works, since most of what fails here is a
              request that timed out.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <button type="button" onClick={reset} className="primary">
                Try again
              </button>
              <Link
                href="/dashboard"
                className="font-mono text-[0.7rem] uppercase tracking-[0.1em] text-[var(--ink-faint)] transition hover:text-[var(--ink-accent-hot)]"
              >
                your boards
              </Link>
            </div>
            {error.digest && (
              <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-faint)]">
                reference {error.digest}
              </p>
            )}
          </div>
        </main>

        <footer className="foot">
          <span>Excalidraw · Supabase · OpenCV · Gemini</span>
        </footer>
      </div>
    </div>
  );
}
