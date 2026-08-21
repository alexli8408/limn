"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { requestOrigin } from "@/lib/origin";

/**
 * Email and OAuth sign-in, and the two ways back in when neither one works: a
 * mailed reset link, and a resend for the confirmation that never arrived.
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
  /**
   * The address a confirmation mail was just promised to. Set only when sign-up
   * left the account unconfirmed, because that is the one moment a resend has
   * anything to resend.
   */
  pendingEmail?: string;
}

/** Where to go after signing in, restricted to paths inside this app. */
function safeNext(value: FormDataEntryValue | null): string {
  const next = String(value ?? "");
  // Must be a site-relative path. `//evil.com` is protocol-relative and would
  // leave the site, so a leading slash on its own is not enough of a check.
  return next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

/**
 * Confirmation and recovery mail both leave through Supabase's shared SMTP,
 * which allows roughly two messages an hour for the whole project rather than
 * per address. Every path that sends mail has to name this case: the alternative
 * is telling someone to check an inbox nothing was ever sent to.
 */
const MAIL_RATE_LIMITED =
  "The shared mail server is rate limited, so nothing was sent. Try again in an hour, or use Continue with Google instead.";

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
    // Sign-up is a send too, so it trips the project cap like the rest. Its raw
    // wording ("email rate limit exceeded") reads as a fault of the address that
    // was just typed, which sends people off to try a different one.
    if (error.code === "over_email_send_rate_limit") return { error: MAIL_RATE_LIMITED };
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
    return {
      notice: `Check ${email} for a confirmation link, then sign in.`,
      pendingEmail: email,
    };
  }

  revalidatePath("/", "layout");
  redirect(next);
}

/**
 * Step one of recovery: mail a link that signs the person in.
 *
 * The answer is the same whether or not that address has an account. This form
 * takes no password, so a truthful "no such account" would hand an anonymous
 * visitor a way to test addresses one at a time and learn who is registered.
 */
export async function requestPasswordReset(
  _previous: AuthResult,
  formData: FormData,
): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Enter the email you signed up with." };

  const supabase = await supabaseServer();
  const origin = await requestOrigin();

  // Back through the same callback as OAuth and confirmation. That route is what
  // exchanges the PKCE code for a session, and the session is the only thing
  // that makes the confirm page usable, so a link pointed straight at
  // /auth/reset/confirm would arrive with an unspent code and nobody signed in.
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/auth/reset/confirm")}`,
  });

  const sent = `If ${email} has an account, a reset link is on its way. Check the spam folder if it does not turn up.`;

  if (!error) return { notice: sent };

  // Worth naming: it has nothing to do with which address was typed, and the
  // line above would leave someone waiting on mail that never left.
  if (error.code === "over_email_send_rate_limit") return { error: MAIL_RATE_LIMITED };

  // Swallowed on purpose. user_not_found is precisely the answer this form must
  // never give, so it collapses back into the neutral one. A malformed address
  // is safe to report, because it describes the typing rather than the account.
  if (error.code === "user_not_found") return { notice: sent };
  if (error.code === "validation_failed" || error.code === "email_address_invalid") {
    return { error: "That does not look like an email address." };
  }

  return {
    error: "The reset email could not be sent. Try again, or use Continue with Google.",
  };
}

/**
 * Step two, reached only through the link: the recovery session sitting in the
 * cookie jar is the whole proof of ownership, which is why no old password is
 * asked for here.
 */
export async function updatePassword(
  _previous: AuthResult,
  formData: FormData,
): Promise<AuthResult> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 8) return { error: "Use at least 8 characters." };
  // Typed twice because a typo here is not fixable by trying again: the old
  // password stops working the moment the new one lands, and the link that got
  // them this far is single use and already spent.
  if (password !== confirm) return { error: "Those two do not match." };

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    // Recovery links expire and are good once, so a missing session here almost
    // always means this one was already used. Supabase words that as "Auth
    // session missing!", which gives nobody a next step. Two checks because the
    // server answers with a code and the client-side guard throws a named error
    // carrying none.
    if (error.name === "AuthSessionMissingError" || error.code === "session_not_found") {
      return { error: "That reset link has expired or was already used. Ask for a new one." };
    }
    if (error.code === "same_password") {
      return { error: "That is the password you already have. Pick a different one." };
    }
    return { error: error.message };
  }

  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/**
 * The other dead end: the account exists but its confirmation mail never showed
 * up. Offered only straight after a sign-up that produced no session, so the
 * address is one this browser just registered rather than anything a stranger
 * typed in to probe with.
 */
export async function resendConfirmation(
  _previous: AuthResult,
  formData: FormData,
): Promise<AuthResult> {
  const email = String(formData.get("email") ?? "").trim();
  const next = safeNext(formData.get("next"));
  if (!email) return { error: "No address to send to. Sign up again." };

  const supabase = await supabaseServer();
  const origin = await requestOrigin();

  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  if (error) {
    // The likeliest outcome by far, since the sign-up that put this button on
    // screen just spent one of the project's couple of sends for the hour.
    if (error.code === "over_email_send_rate_limit") return { error: MAIL_RATE_LIMITED };
    return { error: error.message };
  }

  return { notice: `Sent again to ${email}. It can take a minute to arrive.` };
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
