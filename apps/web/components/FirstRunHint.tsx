"use client";

/**
 * What to do on an empty board.
 *
 * A new board was a blank dark rectangle with no starting point, and Snap is on
 * by default, so a first-time user's opening wobbly circle silently turned into
 * a clean ellipse with nothing anywhere explaining why or how to undo it. The
 * product's headline behaviour arrived as a surprise.
 *
 * pointer-events-none throughout: this sits over the canvas and must never eat
 * the first stroke it is asking for.
 */
export default function FirstRunHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-[2] grid place-items-center px-6">
      <div className="max-w-sm text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--ink-accent)]">
          empty board
        </p>
        <p className="mt-3 text-lg font-[660] leading-snug tracking-[-0.02em] text-[var(--ink-text)]">
          Draw a rough shape and let go.
        </p>
        <ul className="mt-4 space-y-1.5 text-xs leading-relaxed text-[var(--ink-dim)]">
          <li>It snaps to a clean one when you lift the pen.</li>
          <li>
            <span className="text-[var(--ink-text)]">Snap</span> in the header
            turns that off, and one undo gives your wobble back.
          </li>
          <li>
            <span className="text-[var(--ink-text)]">Clean up</span>, bottom
            right, redraws a whole sketch as a proper diagram.
          </li>
        </ul>
      </div>
    </div>
  );
}
