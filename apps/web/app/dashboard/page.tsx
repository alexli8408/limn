import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { startDrawing, deleteBoard, leaveBoard } from "@/app/actions";
import { signOut } from "@/app/auth/actions";
import PendingButton from "@/components/PendingButton";
import BoardCardActions from "@/components/BoardCardActions";
import BoardTitle from "@/components/BoardTitle";
import { publicEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Builds the CDN URL for a stored thumbnail path.
 *
 * The column holds a path inside the bucket, never a URL. It is written by the
 * browser and nothing in the database constrains where a URL would point, so an
 * origin taken from it would be an origin chosen by whoever last had an editor
 * link to the board. This one comes from the app's own configuration; the
 * database only has to guarantee that a board points inside its own folder,
 * which is what boards_guard_thumbnail does.
 */
const thumbnailSrc = (path: string): string =>
  `${publicEnv.supabaseUrl}/storage/v1/object/public/board-thumbnails/${path}`;

export default async function DashboardPage() {
  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/signin?next=%2Fdashboard");

  // RLS decides what is visible here; no owner filter is needed, and adding one
  // would hide boards shared with this user.
  const { data: boards, error } = await supabase
    .from("boards")
    .select("id, title, element_count, updated_at, owner_id, visibility, thumbnail_url")
    .order("updated_at", { ascending: false })
    .limit(60);

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, is_guest")
    .eq("id", auth.user.id)
    .maybeSingle();

  const mine = (boards ?? []).filter((b) => b.owner_id === auth.user.id);
  const shared = (boards ?? []).filter((b) => b.owner_id !== auth.user.id);

  // "0 shared with you" and "1 boards" are the two ways a count line gives away
  // that nobody wrote it, so each case gets its own sentence.
  const countLine =
    shared.length === 0
      ? `${mine.length} ${mine.length === 1 ? "board" : "boards"}.`
      : mine.length === 0
        ? `${shared.length} shared with you.`
        : `${mine.length} of your own, ${shared.length} shared with you.`;

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
                    : countLine}
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
              Reload the page. Nothing has been deleted.
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
  thumbnail_url: string | null;
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
            className="group flex flex-col overflow-hidden border border-[var(--ink-line)] bg-[var(--ink-surface)] transition hover:border-[var(--ink-accent)]"
          >
            {/* The picture is the fastest way to tell one board from another,
                which a grid of text cards never was. Decorative, so it carries
                an empty alt rather than repeating the title beneath it. */}
            <Link href={`/board/${board.id}`} className="block">
              <div className="aspect-[16/10] overflow-hidden border-b border-[var(--ink-line)] bg-[var(--ink-raised)]">
                {board.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumbnailSrc(board.thumbnail_url)}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
                  />
                ) : (
                  // A board with nothing on it has no picture to show. The
                  // paper texture says "blank board" where an empty box would
                  // just read as a thumbnail that failed to load.
                  <div className="relative grid h-full w-full place-items-center">
                    <div className="draft-grid" aria-hidden />
                    <span className="relative font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ink-ghost)]">
                      empty
                    </span>
                  </div>
                )}
              </div>
            </Link>

            <div className="flex flex-1 flex-col gap-1 p-3">
              {/* Outside the Link, so a rename click cannot navigate away. */}
              <BoardTitle
                boardId={board.id}
                title={board.title}
                className="w-full text-sm font-medium text-[var(--ink-text)]"
              />
              <Link
                href={`/board/${board.id}`}
                className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)] transition hover:text-[var(--ink-dim)]"
              >
                {board.element_count === 0
                  ? "Empty"
                  : `${board.element_count} ${board.element_count === 1 ? "element" : "elements"}`}{" "}
                · {new Date(board.updated_at).toLocaleDateString()}
                {/* The column was already selected and thrown away, so a board
                    you had deliberately made private looked identical to one
                    anyone with the link could open. */}
                {board.visibility !== "link" && ` · ${board.visibility}`}
              </Link>
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
