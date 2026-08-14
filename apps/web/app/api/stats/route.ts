import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/** Live counters for the landing page. Cached in Postgres for 60s. */

export const runtime = "nodejs";
export const revalidate = 30;

export async function GET() {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("platform_stats");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return NextResponse.json(data, {
    headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" },
  });
}
