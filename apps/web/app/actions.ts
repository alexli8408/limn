"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Anonymous sign-in, then a new board, in one round trip from the landing page.
 *
 * Anonymous auth is the whole onboarding story: a visitor can be drawing on a
 * shared board in one click, with no email step. They are still a real row in
 * auth.users, so they can own boards and be upgraded in place if they sign up.
 */
export async function startDrawing(formData: FormData) {
  const supabase = await supabaseServer();

  const { data: existing } = await supabase.auth.getUser();
  if (!existing.user) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw new Error(`could not start a session: ${error.message}`);
  }

  const title = String(formData.get("title") ?? "").trim();
  const { data: board, error } = await supabase.rpc("create_board", {
    p_title: title || "Untitled board",
  });
  if (error || !board) throw new Error(`could not create a board: ${error?.message}`);

  revalidatePath("/dashboard");
  redirect(`/board/${board.id}`);
}

export async function renameBoard(boardId: string, title: string) {
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("boards")
    .update({ title: title.trim().slice(0, 200) || "Untitled board" })
    .eq("id", boardId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function deleteBoard(boardId: string) {
  const supabase = await supabaseServer();
  const { error } = await supabase.from("boards").delete().eq("id", boardId);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}
