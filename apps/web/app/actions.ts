"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import type { BoardRole, BoardVisibility } from "@/lib/supabase/types";

/**
 * Board lifecycle and sharing.
 *
 * Everything here needs a signed-in user. Boards used to be created against an
 * anonymous session, which made them a property of one browser rather than of a
 * person: clearing cookies or opening a different browser lost the lot, and
 * there was no way to be invited to anything because there was no stable
 * identity to invite. Sign-in is now the entry point.
 */

async function requireUser(next: string) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(`/signin?next=${encodeURIComponent(next)}`);
  return { supabase, user: data.user };
}

export async function startDrawing(formData: FormData) {
  const { supabase } = await requireUser("/dashboard");

  const title = String(formData.get("title") ?? "").trim();
  const { data: board, error } = await supabase.rpc("create_board", {
    p_title: title || "Untitled board",
  });
  if (error || !board) throw new Error(`Could not create a board: ${error?.message}`);

  revalidatePath("/dashboard");
  redirect(`/board/${board.id}`);
}

export async function renameBoard(boardId: string, title: string) {
  const { supabase } = await requireUser("/dashboard");
  const { error } = await supabase
    .from("boards")
    .update({ title: title.trim().slice(0, 200) || "Untitled board" })
    .eq("id", boardId);
  if (error) throw new Error(error.message);
  // Both surfaces show the title, and renaming from one used to leave the other
  // showing the old name until something else happened to revalidate it.
  revalidatePath("/dashboard");
  revalidatePath(`/board/${boardId}`);
}

/**
 * Names a board from what the AI just recognised in it, but only while it is
 * still called "Untitled board".
 *
 * The model already writes a title on every generation and the code used to
 * throw it away, so a week later every board on the dashboard was called
 * "Untitled board" and none of them could be told apart. Naming only an
 * untitled board means this can never overwrite a name a person chose.
 */
export async function autoTitleBoard(boardId: string, title: string) {
  const clean = title.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!clean) return;

  const { supabase } = await requireUser(`/board/${boardId}`);
  const { error } = await supabase
    .from("boards")
    .update({ title: clean })
    .eq("id", boardId)
    .eq("title", "Untitled board");

  // A board somebody else already named is not an error, it is the guard doing
  // its job, so this stays quiet either way.
  if (error) console.warn("[limn] auto-title skipped:", error.message);
  revalidatePath("/dashboard");
}

export async function deleteBoard(boardId: string) {
  const { supabase } = await requireUser("/dashboard");

  /**
   * The thumbnail first, and it has to be first.
   *
   * board-thumbnails is public, so the object stays readable on the CDN by
   * anyone who has ever seen the board's id until something removes it, and
   * nothing did. It cannot be cleaned up afterwards either: the delete policy
   * asks can_edit_board, which needs the board row that is about to go.
   *
   * Best effort. A board the owner asked to delete should be deleted whether or
   * not the picture of it could be tidied away first.
   */
  const { error: thumbError } = await supabase.storage
    .from("board-thumbnails")
    .remove([`${boardId}/thumb.png`]);
  if (thumbError) console.warn("[limn] thumbnail not removed:", thumbError.message);

  const { error } = await supabase.from("boards").delete().eq("id", boardId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/** Leave a board someone else shared with you, without involving its owner. */
export async function leaveBoard(boardId: string) {
  const { supabase, user } = await requireUser("/dashboard");
  const { error } = await supabase
    .from("board_collaborators")
    .delete()
    .eq("board_id", boardId)
    .eq("user_id", user.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/* ------------------------------------------------------------------ */
/* sharing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Whether the share link hands out editing or viewing.
 *
 * Only the owner may call this in effect: the boards_guard_sharing trigger
 * rejects a link_role change from anyone else, so this is a convenience, not the
 * enforcement point.
 */
export async function setLinkRole(boardId: string, role: BoardRole) {
  if (role !== "editor" && role !== "viewer") {
    throw new Error("Could not change what the link grants.");
  }
  const { supabase } = await requireUser(`/board/${boardId}`);

  const { error } = await supabase
    .from("boards")
    .update({ link_role: role })
    .eq("id", boardId);
  if (error) throw new Error(error.message);

  revalidatePath(`/board/${boardId}`);
}

/**
 * Turns link sharing on or off.
 *
 * boards.visibility has defaulted to 'link' since the schema was written and no
 * code path ever wrote it, so every board was link-shared from creation with no
 * way to stop that. "Reset the link" only minted a new working link, which is
 * not the same as revoking. 'public' has been a working read-only mode in
 * can_read_board the whole time and was simply unreachable.
 *
 * The boards_guard_sharing trigger already rejects this from anyone but the
 * owner, so the check here is a convenience, not the enforcement point.
 */
export async function setVisibility(
  boardId: string,
  visibility: BoardVisibility,
) {
  if (!["private", "link", "public"].includes(visibility)) {
    throw new Error("Could not change who can open this board.");
  }
  const { supabase } = await requireUser(`/board/${boardId}`);

  const { error } = await supabase
    .from("boards")
    .update({ visibility })
    .eq("id", boardId);
  if (error) throw new Error(error.message);

  revalidatePath(`/board/${boardId}`);
  revalidatePath("/dashboard");
}

/** Invalidates the old link. Anyone already admitted keeps their access. */
export async function rotateShareLink(boardId: string): Promise<string> {
  const { supabase } = await requireUser(`/board/${boardId}`);
  const { data, error } = await supabase.rpc("rotate_share_token", {
    p_board_id: boardId,
  });
  if (error || !data) throw new Error(error?.message ?? "Could not reset the link.");
  revalidatePath(`/board/${boardId}`);
  return data;
}

/** Removes a collaborator's access outright, rather than just rotating the link. */
export async function removeCollaborator(boardId: string, userId: string) {
  const { supabase } = await requireUser(`/board/${boardId}`);
  const { error } = await supabase
    .from("board_collaborators")
    .delete()
    .eq("board_id", boardId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  revalidatePath(`/board/${boardId}`);
}
