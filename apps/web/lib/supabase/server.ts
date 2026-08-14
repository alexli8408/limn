import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";
import type { Database } from "./types";

/**
 * Request-scoped client for server components and route handlers.
 *
 * Always constructed fresh: it closes over the current request's cookie jar, so
 * caching one across requests would serve one user's session to another.
 */
export async function supabaseServer() {
  const store = await cookies();

  return createServerClient<Database>(
    publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return store.getAll();
        },
        setAll(entries) {
          try {
            for (const { name, value, options } of entries) {
              store.set(name, value, options);
            }
          } catch {
            // Server components cannot set cookies. Refresh still happens in
            // middleware, so treating this as fatal would break every read.
          }
        },
      },
    },
  );
}
