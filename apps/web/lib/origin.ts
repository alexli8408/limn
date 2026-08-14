import { headers } from "next/headers";
import { publicEnv } from "@/lib/env";

/**
 * The origin this request actually arrived on.
 *
 * Share links and the OAuth redirect both have to point back at the site the
 * user is currently looking at. Building them from a fixed env var breaks the
 * moment the two disagree, and they disagree constantly: Next picks a different
 * port when 3000 is taken, Vercel gives every preview deployment its own
 * hostname, and a share link built from the wrong one silently sends the invitee
 * to a dead address or, worse, to whatever else is on that port.
 *
 * NEXT_PUBLIC_SITE_URL stays as the fallback for contexts with no request in
 * scope, but it is no longer the first answer.
 */
export async function requestOrigin(): Promise<string> {
  const store = await headers();

  const host = store.get("x-forwarded-host") ?? store.get("host");
  if (!host) return publicEnv.siteUrl;

  const proto =
    store.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");

  return `${proto}://${host}`;
}
