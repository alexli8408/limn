import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { SyncElement } from "@limn/protocol";
import { supabaseServer } from "@/lib/supabase/server";
import { requestOrigin } from "@/lib/origin";
import BoardCanvasLoader from "@/components/BoardCanvasLoader";

/**
 * Board page.
 *
 * The scene is loaded here, on the server, rather than fetched from the client
 * after mount. Excalidraw takes its elements once via `initialData`, so having
 * them in hand before the canvas mounts avoids a visible empty-board flash and
 * an immediate second scene update.
 */

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}

/** Shown when the board exists but this account cannot open it. */
function NoAccess({ linkWasReset }: { linkWasReset: boolean }) {
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
            <p className="eyebrow">no access</p>
            <h1 className="mb-3 text-[1.9rem] font-[780] leading-[1.15] tracking-[-0.03em] text-balance">
              {linkWasReset ? (
                <>
                  That share link{" "}
                  <span className="text-[var(--ink-accent)]">no longer works.</span>
                </>
              ) : (
                <>
                  This board has not been{" "}
                  <span className="text-[var(--ink-accent)]">shared with you.</span>
                </>
              )}
            </h1>
            <p className="mb-8 text-sm leading-relaxed text-[var(--ink-dim)]">
              {linkWasReset
                ? "Share links stop working as soon as the owner resets them, which is how access is revoked. Ask them for a fresh link."
                : "You are signed in, but this board is private to the people it has been shared with. Ask the owner for a link."}
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

export default async function BoardPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { t: shareToken } = await searchParams;

  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();

  if (!auth.user) {
    // Keep the share token on the round trip, so an invitee who has to sign in
    // first still lands on the board rather than on an empty dashboard.
    const next = shareToken ? `/board/${id}?t=${shareToken}` : `/board/${id}`;
    redirect(`/signin?next=${encodeURIComponent(next)}`);
  }

  // A share token grants nothing until it is redeemed for a collaborator row,
  // RLS cannot see a token held by the browser. Redeeming is idempotent.
  let tokenRejected = false;
  if (shareToken) {
    const { error } = await supabase.rpc("claim_board_access", {
      p_share_token: shareToken,
    });
    if (error) {
      tokenRejected = true;
      console.warn("[limn] share token rejected:", error.message);
    }
  }

  const { data: board } = await supabase
    .from("boards")
    .select("id, title, owner_id, visibility, share_token, link_role")
    .eq("id", id)
    .maybeSingle();

  if (!board) notFound();

  const { data: role } = await supabase.rpc("board_role_for", { p_board_id: id });
  // Distinguish "this link is dead" from "this board is not shared with you".
  // Both used to fall through to a bare 404, which left an invitee with no idea
  // whether to ask for a new link or to ask to be added at all.
  if (!role) return <NoAccess linkWasReset={tokenRejected || Boolean(shareToken)} />;

  const { data: snapshot } = await supabase
    .from("board_snapshots")
    .select("elements, version")
    .eq("board_id", id)
    .maybeSingle();

  void supabase.rpc("touch_board_opened", { p_board_id: id });

  const profile = await supabase
    .from("profiles")
    .select("display_name, avatar_url, is_guest")
    .eq("id", auth.user.id)
    .maybeSingle();

  const elements = (snapshot?.elements ?? []) as SyncElement[];
  // Built from the host this request arrived on, so a link copied on localhost
  // points at localhost and one copied on a preview points at that preview.
  const origin = await requestOrigin();
  // The token is only sent to people who can actually invite with it. A viewer
  // used to receive a working editor link in their page payload, which is a
  // privilege escalation available to anyone who opened devtools.
  const shareUrl =
    role === "viewer" ? "" : `${origin}/board/${board.id}?t=${board.share_token}`;

  return (
    <main className="h-full">
      <BoardCanvasLoader
        boardId={board.id}
        title={board.title}
        userId={auth.user.id}
        displayName={profile.data?.display_name ?? "Anonymous"}
        role={role}
        guest={profile.data?.is_guest ?? true}
        avatarUrl={profile.data?.avatar_url ?? undefined}
        initialElements={elements}
        initialVersion={snapshot?.version ?? 0}
        shareUrl={shareUrl}
        ownerId={board.owner_id}
        linkRole={board.link_role}
      />
    </main>
  );
}
