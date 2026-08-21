import Link from "next/link";

/**
 * 404, in the product's own shell.
 *
 * Next's stock not-found is black system text on white, which after a dark
 * violet board reads as the site having broken rather than as a page being
 * missing. The two ways a real person reaches this are a board that was deleted
 * and a share link whose token was reset, so the copy names both instead of
 * saying "page not found".
 */
export default function NotFound() {
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
            <p className="eyebrow">nothing here</p>
            <h1 className="mb-3 text-[1.9rem] font-[780] leading-[1.15] tracking-[-0.03em] text-balance">
              That board is gone, or the link{" "}
              <span className="text-[var(--ink-accent)]">pointing at it was reset.</span>
            </h1>
            <p className="mb-8 text-sm leading-relaxed text-[var(--ink-dim)]">
              Boards can be deleted by their owner, and a share link stops working
              the moment it is reset. Ask whoever shared it for a fresh link.
            </p>
            <Link href="/dashboard" className="primary">
              Your boards
            </Link>
          </div>
        </main>

        <footer className="foot">
          <span>Excalidraw · Supabase · OpenCV · Gemini</span>
        </footer>
      </div>
    </div>
  );
}
