import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { startDrawing, deleteBoard, leaveBoard } from "@/app/actions";
import { signOut } from "@/app/auth/actions";
import PendingButton from "@/components/PendingButton";
import BoardCardActions from "@/components/BoardCardActions";
import BoardTitle from "@/components/BoardTitle";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/signin?next=%2Fdashboard");

  // RLS decides what is visible here; no owner filter is needed, and adding one
  // would hide boards shared with this user.
  const { data: boards, error } = await supabase
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
              <h1 className="mb-3 text-[1.9rem] font-[780] leading-[1.15] tracking-[-0.03em] text-balance text-[var(--ink-text)]">Your boards</h1>
              <p className="mt-1.5 text-sm text-[var(--ink-dim)]">
                {error
                  ? "Could not load your boards."
                  : mine.length + shared.length === 0
                    ? "Nothing here yet. Make one and send someone the link."
                    : `${mine.length} of your own, ${shared.length} shared with you.`}
              </p>
            </div>

            {/* Naming on creation, so a board arrives with an identity instead
                of joining a grid of cards all called "Untitled board". */}
            <form action={startDrawing} className="flex items-center gap-2">
              <input
                name="title"
                placeholder="Name it, or leave blank"
                maxLength={200}
                className="w-52 rounded-sm border border-[var(--ink-line)] bg-[var(--ink-void)] px-2.5 py-2 text-sm text-[var(--ink-text)] outline-none placeholder:text-[var(--ink-faint)] focus-visible:border-[var(--ink-accent)]"
              />
              <PendingButton pendingLabel="Opening…" className="primary">
                New board
              </PendingButton>
            </form>
          </div>

          {error && (
            <p className="mt-12 border border-[var(--ink-bad)]/40 bg-[var(--ink-bad)]/10 p-8 text-center text-sm text-[var(--ink-bad)]">
              Could not load your boards. Reload to try again.
            </p>
          )}

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
  visibility: "private" | "link" | "public";
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
            className="group relative flex flex-col border border-[var(--ink-line)] bg-[var(--ink-surface)] transition hover:border-[var(--ink-accent)]"
          >
            <Link href={`/board/${board.id}`} className="block flex-1 p-4 pb-2">
              <span className="mt-1.5 block font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
                {board.element_count} elements ·{" "}
                {new Date(board.updated_at).toLocaleDateString()}
                {/* The column was already being selected and thrown away, so a
                    board you had deliberately made private looked identical to
                    one anyone with the link could open. */}
                {board.visibility !== "link" && ` · ${board.visibility}`}
              </span>
            </Link>

            {/* Title sits outside the Link so a rename click cannot navigate. */}
            <div className="pointer-events-none absolute inset-x-4 top-4">
              <div className="pointer-events-auto">
                <BoardTitle
                  boardId={board.id}
                  title={board.title}
                  className="w-full text-sm font-medium text-[var(--ink-text)]"
                />
              </div>
            </div>

            <div className="flex justify-end border-t border-[var(--ink-line)] px-2 py-1.5">
              <BoardCardActions
                boardId={board.id}
                boardTitle={board.title}
                verb={verb}
                action={action}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
