import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import AuthForm from "@/components/AuthForm";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ next?: string; error?: string }>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const { next, error } = await searchParams;
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (auth.user) redirect(target);

  // Invitees land here first, so say what they are being let into rather than
  // showing a bare form and hoping they push through it.
  const invited = target.startsWith("/board/");

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
            <p className="eyebrow">{invited ? "you were invited" : "welcome back"}</p>
            <h1 className="mb-3 text-[1.9rem] font-[780] leading-[1.15] tracking-[-0.03em] text-balance">
              {invited ? (
                <>
                  Sign in to join{" "}
                  <span className="text-[var(--ink-accent)]">the board.</span>
                </>
              ) : (
                <>
                  Sign in to your{" "}
                  <span className="text-[var(--ink-accent)]">boards.</span>
                </>
              )}
            </h1>
            <p className="mb-8 text-sm leading-relaxed text-[var(--ink-dim)]">
              {invited
                ? "Boards are shared with people, not with links alone, so we need to know who you are before letting you in."
                : "Your boards follow your account, so they are there on any browser you sign in from."}
            </p>

            <AuthForm next={target} initialError={error} />
          </div>
        </main>

        <footer className="foot">
          <span>Excalidraw · Supabase · OpenCV · Gemini</span>
        </footer>
      </div>
    </div>
  );
}
