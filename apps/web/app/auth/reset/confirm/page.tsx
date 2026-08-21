import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { NewPasswordForm } from "@/components/AuthForm";

// Reads the session cookie, so there is nothing here to prerender.
export const dynamic = "force-dynamic";

/**
 * Where the recovery link lands, one hop after /auth/callback.
 *
 * The callback has already traded the PKCE code for a session by the time
 * anyone arrives, so the presence of a user is the whole test: no user means the
 * link expired, was opened a second time, or the URL was typed in by hand. That
 * is worth saying up front, because the alternative is a password form whose
 * only possible outcome is a failure after the typing is done.
 */
export default async function ConfirmResetPage() {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  const user = auth.user;

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
            <p className="eyebrow">{user ? "new password" : "expired link"}</p>
            <h1 className="mb-3 text-[1.9rem] font-[780] leading-[1.15] tracking-[-0.03em] text-balance">
              {user ? (
                <>
                  Pick a new{" "}
                  <span className="text-[var(--ink-accent)]">password.</span>
                </>
              ) : (
                <>
                  That link is{" "}
                  <span className="text-[var(--ink-accent)]">already spent.</span>
                </>
              )}
            </h1>
            <p className="mb-8 text-sm leading-relaxed text-[var(--ink-dim)]">
              {user
                ? `Signed in${user.email ? ` as ${user.email}` : ""}. Set a password and you land straight back in your boards.`
                : "Reset links work once and then expire. Ask for a fresh one and it will let you through."}
            </p>

            {user ? (
              <NewPasswordForm />
            ) : (
              <Link href="/auth/reset" className="primary">
                Send a new link
              </Link>
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
