import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { startDrawing, deleteBoard, leaveBoard } from "@/app/actions";
import { signOut } from "@/app/auth/actions";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/signin?next=%2Fdashboard");

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

  const mine = (boards ?? []).filter((b) => b.owner_id === auth.user.id);
  const shared = (boards ?? []).filter((b) => b.owner_id !== auth.user.id);

  // Bound to the row they sit in, so each card gets its own submit target
  // without a client component just to hold a board id.
  async function removeBoard(formData: FormData) {
    "use server";
    await deleteBoard(String(formData.get("id")));
  }

  async function leave(formData: FormData) {
    "use server";
    await leaveBoard(String(formData.get("id")));
  }

  return (
    <div className="landing min-h-screen">
      <div className="paper" aria-hidden />

      <div className="shell relative">
        <header className="bar">
          <Link href="/" className="mark text-[var(--ink-text)] no-underline">
            limn
          </Link>
          <nav className="items-center gap-5">
            <span className="text-[var(--ink-dim)]">
              {profile?.display_name ?? auth.user.email}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="font-mono text-[0.7rem] uppercase tracking-[0.1em] text-[var(--ink-faint)] transition hover:text-[var(--ink-accent-hot)]"
              >
                sign out
              </button>
            </form>
          </nav>
        </header>
        <hr className="rule" />

        <main className="pb-24 pt-12">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="title text-[var(--ink-text)]">Your boards</h1>
              <p className="mt-1.5 text-sm text-[var(--ink-dim)]">
                {mine.length + shared.length === 0
                  ? "Nothing here yet. Make one and send someone the link."
                  : `${mine.length} of your own, ${shared.length} shared with you.`}
              </p>
            </div>
            <form action={startDrawing}>
              <button type="submit" className="primary">
                New board
              </button>
            </form>
          </div>

          <Section title="Yours" boards={mine} action={removeBoard} verb="Delete" />
          <Section title="Shared with you" boards={shared} action={leave} verb="Leave" />
        </main>
      </div>
    </div>
  );
}

interface BoardSummary {
  id: string;
  title: string;
  element_count: number;
  updated_at: string;
}

function Section({
  title,
  boards,
  action,
  verb,
}: {
  title: string;
  boards: BoardSummary[];
  action: (formData: FormData) => Promise<void>;
  verb: string;
}) {
  if (boards.length === 0) return null;

  return (
    <section className="mt-12">
      <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ink-faint)]">
        {title}
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {boards.map((board) => (
          <li
            key={board.id}
            className="group relative border border-[var(--ink-line)] bg-[var(--ink-surface)] transition hover:border-[var(--ink-accent)]"
          >
            <Link href={`/board/${board.id}`} className="block p-4">
              <span className="block truncate pr-6 font-medium text-[var(--ink-text)]">
                {board.title}
              </span>
              <span className="mt-1.5 block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
                {board.element_count} elements ·{" "}
                {new Date(board.updated_at).toLocaleDateString()}
              </span>
            </Link>
            <form action={action} className="absolute right-2 top-2">
              <input type="hidden" name="id" value={board.id} />
              <button
                type="submit"
                title={verb}
                aria-label={`${verb} ${board.title}`}
                className="rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--ink-bad)] focus-visible:opacity-100"
              >
                {verb}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
