import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

// TEMPORARY verification scaffold. Not committed.
export async function GET(request: NextRequest) {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const name = new URL(request.url).searchParams.get("name");
  if (name) await supabase.from("profiles").update({ display_name: name }).eq("id", data.user!.id);
  return NextResponse.redirect(new URL("/dashboard", new URL(request.url).origin));
}
