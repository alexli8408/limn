import { notFound, redirect } from "next/navigation";
import type { SyncElement } from "@limn/protocol";
import { supabaseServer } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";
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

export default async function BoardPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { t: shareToken } = await searchParams;

  const supabase = await supabaseServer();
  const { data: auth } = await supabase.auth.getUser();

  if (!auth.user) {
    const next = shareToken ? `/board/${id}?t=${shareToken}` : `/board/${id}`;
    redirect(`/?next=${encodeURIComponent(next)}`);
  }

  // A share token grants nothing until it is redeemed for a collaborator row —
  // RLS cannot see a token held by the browser. Redeeming is idempotent.
  if (shareToken) {
    const { error } = await supabase.rpc("claim_board_access", {
      p_share_token: shareToken,
    });
    if (error) console.warn("[limn] share token rejected:", error.message);
  }

  const { data: board } = await supabase
    .from("boards")
    .select("id, title, owner_id, visibility, share_token")
    .eq("id", id)
    .maybeSingle();

  if (!board) notFound();

  const { data: role } = await supabase.rpc("board_role_for", { p_board_id: id });
  if (!role) notFound();

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
  const shareUrl = `${publicEnv.siteUrl}/board/${board.id}?t=${board.share_token}`;

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
      />
    </main>
  );
}
