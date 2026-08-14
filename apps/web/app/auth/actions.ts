"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { requestOrigin } from "@/lib/origin";

/**
 * Email and OAuth sign-in.
 *
 * These return a message rather than throwing, because every failure here is
 * something the person typing can fix: wrong password, address already taken,
 * unconfirmed email. Throwing would show them the error overlay in development
 * and a blank 500 in production, neither of which tells them to check the
 * password they just typed.
 */

export interface AuthResult {
  error?: string;
  notice?: string;
}

/** Where to go after signing in, restricted to paths inside this app. */
function safeNext(value: FormDataEntryValue | null): string {
  const next = String(value ?? "");
  // Must be a site-relative path. `//evil.com` is protocol-relative and would
  // leave the site, so a leading slash on its own is not enough of a check.
  return next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

export async function signInWithPassword(
  _previous: AuthResult,
  formData: FormData,
): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));

  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return {
      error:
        error.code === "invalid_credentials"
          ? "That email and password do not match an account."
          : error.message,
    };
  }

  revalidatePath("/", "layout");
  redirect(next);
}

export async function signUpWithPassword(
  _previous: AuthResult,
  formData: FormData,
): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const next = safeNext(formData.get("next"));

  if (!email || !password) return { error: "Enter an email and a password." };
  if (password.length < 8) return { error: "Use at least 8 characters." };

  const supabase = await supabaseServer();
  const origin = await requestOrigin();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Read by handle_new_user() to fill in the profile, so a new account has a
      // name on its cursor from the first frame instead of "Guest".
      data: name ? { display_name: name } : undefined,
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error) {
    return {
      error:
        error.code === "user_already_exists"
          ? "There is already an account with that email. Sign in instead."
          : error.message,
    };
  }

  // With email confirmation switched on, signUp returns a user but no session.
  // Saying "check your email" only when that is actually true keeps the message
  // honest across both project settings.
  if (!data.session) {
    return { notice: `Check ${email} for a confirmation link, then sign in.` };
  }

  revalidatePath("/", "layout");
  redirect(next);
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const next = safeNext(formData.get("next"));
  const supabase = await supabaseServer();
  const origin = await requestOrigin();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error || !data.url) {
    redirect(`/signin?error=${encodeURIComponent(error?.message ?? "Google sign-in is unavailable.")}`);
  }

  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/");
}
