import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { startDrawing } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/");

  // RLS decides what is visible here; no owner filter is needed, and adding one
  // would hide boards shared with this user.
  const { data: boards } = await supabase
    .from("boards")
    .select("id, title, element_count, updated_at, owner_id, visibility")
    .order("updated_at", { ascending: false })
    .limit(60);

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, is_guest")
    .eq("id", auth.user.id)
    .maybeSingle();

  return (
    <main className="mx-auto max-w-4xl px-6 py-14">
      <div className="flex items-end justify-between gap-4">
        <div>
          <Link href="/" className="font-mono text-sm font-bold uppercase tracking-[0.14em] text-[var(--ink-faint)] transition hover:text-[var(--ink-accent)]">
            limn
          </Link>
          <h1 className="mt-2 text-3xl font-bold tracking-[-0.03em] text-[var(--ink-text)]">Your boards</h1>
          <p className="mt-1.5 text-sm text-[var(--ink-dim)]">
            {profile?.is_guest
              ? "You are signed in as a guest. Boards stay in this browser session."
              : `Signed in as ${profile?.display_name ?? "you"}.`}
          </p>
        </div>

        <form action={startDrawing}>
          <button
            type="submit"
            className="rounded-sm bg-[var(--ink-accent)] px-4 py-2 text-sm font-semibold text-[#0b0813] transition hover:bg-[var(--ink-accent-hot)]"
          >
            New board
          </button>
        </form>
      </div>

      {!boards || boards.length === 0 ? (
        <p className="mt-12 border border-dashed border-[var(--ink-line)] p-12 text-center text-sm text-[var(--ink-faint)]">
          No boards yet. Create one and start sketching.
        </p>
      ) : (
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {boards.map((board) => (
            <li key={board.id}>
              <Link
                href={`/board/${board.id}`}
                className="block border border-[var(--ink-line)] bg-[var(--ink-surface)] p-4 transition hover:border-[var(--ink-accent)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate font-medium">{board.title}</span>
                  {board.owner_id !== auth.user.id && (
                    <span className="shrink-0 border border-[var(--ink-line)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
                      shared
                    </span>
                  )}
                </div>
                <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
                  {board.element_count} elements ·{" "}
                  {new Date(board.updated_at).toLocaleDateString()}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
