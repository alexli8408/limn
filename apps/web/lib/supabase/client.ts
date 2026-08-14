"use client";

import { createBrowserClient } from "@supabase/ssr";
import { REALTIME_EVENTS_PER_SECOND } from "@limn/protocol";
import { publicEnv } from "@/lib/env";
import type { Database } from "./types";

let cached: ReturnType<typeof create> | null = null;

function create() {
  return createBrowserClient<Database>(
    publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
    {
      realtime: {
        // The default client-side bucket is 10 events/s, which starves a 30 fps
        // scene channel and silently drops the tail of a fast drag. Our own
        // coalescing keeps actual traffic well under this ceiling.
        params: { eventsPerSecond: REALTIME_EVENTS_PER_SECOND },
      },
    },
  );
}

/**
 * One browser client per tab. A second instance would open a second websocket
 * and register its own presence, so every user would appear twice in the roster.
 */
export function supabaseBrowser() {
  cached ??= create();
  return cached;
}
