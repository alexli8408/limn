import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiMode, Database } from "@/lib/supabase/types";

/**
 * Records a generation for the usage counters on the landing page.
 *
 * Never allowed to fail a request: the diagram is already built by the time this
 * runs, and losing a telemetry row is not a reason to hand the user an error.
 */
export async function recordGeneration(
  supabase: SupabaseClient<Database>,
  row: Database["public"]["Tables"]["ai_generations"]["Insert"],
): Promise<void> {
  const { error } = await supabase.from("ai_generations").insert(row);
  if (error) console.warn("[limn] usage insert failed:", error.message);
}

export type { AiMode };
