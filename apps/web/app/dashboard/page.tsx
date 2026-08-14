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
    <main className="mx-auto max-w-4xl px-6 py-12">
      <div className="flex items-end justify-between gap-4">
        <div>
          <Link href="/" className="font-mono text-sm text-neutral-400">
            limn
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Your boards</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {profile?.is_guest
              ? "You are signed in as a guest. Boards stay in this browser session."
              : `Signed in as ${profile?.display_name ?? "you"}.`}
          </p>
        </div>

        <form action={startDrawing}>
          <button
            type="submit"
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900"
          >
            New board
          </button>
        </form>
      </div>

      {!boards || boards.length === 0 ? (
        <p className="mt-12 rounded-lg border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No boards yet. Create one and start sketching.
        </p>
      ) : (
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {boards.map((board) => (
            <li key={board.id}>
              <Link
                href={`/board/${board.id}`}
                className="block rounded-lg border border-neutral-200 p-4 transition hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate font-medium">{board.title}</span>
                  {board.owner_id !== auth.user.id && (
                    <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800">
                      shared
                    </span>
                  )}
                </div>
                <p className="mt-1 font-mono text-xs text-neutral-400">
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
