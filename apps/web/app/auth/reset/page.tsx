import Link from "next/link";
import { ResetRequestForm } from "@/components/AuthForm";

/**
 * Where a forgotten password gets unstuck.
 *
 * No session lookup and no redirect for people who are already signed in: the
 * only thing this page does is hand an address to Supabase, and someone whose
 * session is alive on one device is exactly the sort of person who still needs
 * a link mailed to the one they are locked out of.
 */
export default function ResetPasswordPage() {
  return (
    <div className="landing min-h-screen">
      <div className="paper" aria-hidden />

      <div className="shell relative flex min-h-screen flex-col">
        <header className="bar">
          <Link href="/" className="mark text-[var(--ink-text)] no-underline">
            limn
          </Link>
          <nav>
            <a href="https://github.com/alexli8408/limn">source</a>
          </nav>
        </header>
        <hr className="rule" />

        <main className="flex flex-1 items-center justify-center py-16">
          <div className="w-full max-w-sm">
            <p className="eyebrow">password reset</p>
            <h1 className="mb-3 text-[1.9rem] font-[780] leading-[1.15] tracking-[-0.03em] text-balance">
              Send yourself a{" "}
              <span className="text-[var(--ink-accent)]">way back in.</span>
            </h1>
            <p className="mb-8 text-sm leading-relaxed text-[var(--ink-dim)]">
              The link in that email signs you in for long enough to pick a new
              password. If you started with Google there is no password to
              reset, so Continue with Google on the sign-in page is the faster
              way home.
            </p>

            <ResetRequestForm />
          </div>
        </main>

        <footer className="foot">
          <span>Excalidraw · Supabase · OpenCV · Gemini</span>
        </footer>
      </div>
    </div>
  );
}
