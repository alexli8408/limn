import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Where Google (and the email confirmation link) come back to.
 *
 * Supabase's browser client uses PKCE, so what arrives here is a one-time code,
 * not a session. Exchanging it server-side is what writes the auth cookies, and
 * doing it in a route handler rather than a server component matters: server
 * components cannot set cookies, so the same code there would appear to succeed
 * and then leave the user signed out.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawNext = url.searchParams.get("next") ?? "/dashboard";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  // The provider reports a refusal here too, e.g. the user cancelled the Google
  // consent screen. That is not an error worth a stack trace, just send them back.
  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) {
    return NextResponse.redirect(
      new URL(`/signin?error=${encodeURIComponent(providerError)}`, url.origin),
    );
  }

  if (!code) {
    return NextResponse.redirect(new URL("/signin?error=Missing+sign-in+code", url.origin));
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(`/signin?error=${encodeURIComponent(error.message)}`, url.origin),
    );
  }

  // Built from url.origin, not from a configured site URL: this request already
  // arrived on the right host, and previews and localhost each have their own.
  return NextResponse.redirect(new URL(next, url.origin));
}
