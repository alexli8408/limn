"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  requestPasswordReset,
  resendConfirmation,
  signInWithGoogle,
  signInWithPassword,
  signUpWithPassword,
  updatePassword,
  type AuthResult,
} from "@/app/auth/actions";

interface Props {
  /** Path to return to once signed in, e.g. the board they were invited to. */
  next: string;
  /** Surfaced by the OAuth callback, which can only report back through the URL. */
  initialError?: string;
}

/* Hoisted out of the component because the recovery forms below are separate
   components rendered on their own pages, and a password field that does not
   match the one on /signin reads as a different site. */
const field =
  "w-full rounded-sm border border-[var(--ink-line)] bg-[var(--ink-void)] px-3 py-2.5 text-sm text-[var(--ink-text)] outline-none transition placeholder:text-[var(--ink-faint)] focus:border-[var(--ink-accent)]";

const fieldLabel =
  "font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-faint)]";

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-sm bg-[var(--ink-accent)] px-4 py-2.5 text-sm font-semibold text-[#0b0813] transition hover:bg-[var(--ink-accent-hot)] disabled:opacity-50"
    >
      {pending ? busy : label}
    </button>
  );
}

/* A div rather than a p: the sign-up notice carries the resend form inside it,
   and a form nested in a paragraph is closed by the parser before it renders. */
function Banner({ tone, children }: { tone: "bad" | "good"; children: React.ReactNode }) {
  const skin =
    tone === "bad"
      ? "border-[var(--ink-bad)]/40 bg-[var(--ink-bad)]/10 text-[var(--ink-bad)]"
      : "border-[var(--ink-good)]/40 bg-[var(--ink-good)]/10 text-[var(--ink-good)]";
  return (
    <div className={`mt-4 rounded-sm border px-3 py-2 text-xs leading-relaxed ${skin}`}>
      {children}
    </div>
  );
}

export default function AuthForm({ next, initialError }: Props) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  const [signInState, signInAction] = useActionState<AuthResult, FormData>(
    signInWithPassword,
    {},
  );
  const [signUpState, signUpAction] = useActionState<AuthResult, FormData>(
    signUpWithPassword,
    {},
  );
  const [resendState, resendAction] = useActionState<AuthResult, FormData>(
    resendConfirmation,
    {},
  );

  const state = mode === "signin" ? signInState : signUpState;
  const message = state.error ?? initialError;

  return (
    <div className="w-full max-w-sm">
      <div className="mb-7 flex border-b border-[var(--ink-line)]">
        {(
          [
            ["signin", "Sign in"],
            ["signup", "Create account"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setMode(key)}
            className={`-mb-px flex-1 border-b-2 px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] transition ${
              mode === key
                ? "border-[var(--ink-accent)] text-[var(--ink-text)]"
                : "border-transparent text-[var(--ink-faint)] hover:text-[var(--ink-dim)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <form action={signInWithGoogle}>
        <input type="hidden" name="next" value={next} />
        <button
          type="submit"
          className="flex w-full items-center justify-center gap-2.5 rounded-sm border border-[var(--ink-line-bright)] px-4 py-2.5 text-sm font-medium text-[var(--ink-text)] transition hover:border-[var(--ink-accent)] hover:bg-[var(--ink-accent-wash)]"
        >
          <GoogleMark />
          Continue with Google
        </button>
      </form>

      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-[var(--ink-line)]" />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ink-faint)]">
          or
        </span>
        <span className="h-px flex-1 bg-[var(--ink-line)]" />
      </div>

      <form
        key={mode}
        action={mode === "signin" ? signInAction : signUpAction}
        className="space-y-3"
      >
        <input type="hidden" name="next" value={next} />

        {mode === "signup" && (
          <label className="block">
            <span className={`mb-1.5 block ${fieldLabel}`}>Name</span>
            <input
              name="name"
              autoComplete="name"
              placeholder="What people on the board see"
              className={field}
            />
          </label>
        )}

        <label className="block">
          <span className={`mb-1.5 block ${fieldLabel}`}>Email</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className={field}
          />
        </label>

        {/* The label is no longer the wrapper here, because the way out sits on
            the same row and a link inside a label steals the click. */}
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <label htmlFor="auth-password" className={fieldLabel}>
              Password
            </label>
            {mode === "signin" && (
              <Link
                href="/auth/reset"
                className={`${fieldLabel} transition hover:text-[var(--ink-accent-hot)]`}
              >
                Forgot password
              </Link>
            )}
          </div>
          <input
            id="auth-password"
            name="password"
            type="password"
            required
            minLength={mode === "signup" ? 8 : undefined}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
            className={field}
          />
        </div>

        <div className="pt-1">
          <Submit
            label={mode === "signin" ? "Sign in" : "Create account"}
            busy={mode === "signin" ? "Signing in…" : "Creating account…"}
          />
        </div>
      </form>

      {message && <Banner tone="bad">{message}</Banner>}

      {state.notice && (
        <Banner tone="good">
          {/* Once a resend has been asked for, its result is the newer truth, so
              it takes over the line instead of stacking a second green box. */}
          {resendState.notice ?? state.notice}
          {state.pendingEmail && (
            <form action={resendAction} className="mt-2">
              <input type="hidden" name="email" value={state.pendingEmail} />
              <input type="hidden" name="next" value={next} />
              <Resend />
            </form>
          )}
        </Banner>
      )}

      {resendState.error && <Banner tone="bad">{resendState.error}</Banner>}
    </div>
  );
}

/* Deliberately a line of text and not a button. Google is the path most people
   take, and a second filled control under the notice would pull harder than it. */
function Resend() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="font-mono text-[10px] uppercase tracking-[0.14em] underline underline-offset-4 transition hover:text-[var(--ink-text)] disabled:opacity-50"
    >
      {pending ? "Sending…" : "Resend the email"}
    </button>
  );
}

/** /auth/reset: ask for an address, say the same thing back either way. */
export function ResetRequestForm() {
  const [state, action] = useActionState<AuthResult, FormData>(requestPasswordReset, {});

  return (
    <div className="w-full max-w-sm">
      <form action={action} className="space-y-3">
        <label className="block">
          <span className={`mb-1.5 block ${fieldLabel}`}>Email</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            className={field}
          />
        </label>

        <div className="pt-1">
          <Submit label="Email me a reset link" busy="Sending…" />
        </div>
      </form>

      {state.error && <Banner tone="bad">{state.error}</Banner>}
      {state.notice && <Banner tone="good">{state.notice}</Banner>}

      <p className="mt-6">
        <Link
          href="/signin"
          className={`${fieldLabel} transition hover:text-[var(--ink-accent-hot)]`}
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

/** /auth/reset/confirm: only useful with the recovery session already in place. */
export function NewPasswordForm() {
  const [state, action] = useActionState<AuthResult, FormData>(updatePassword, {});

  return (
    <div className="w-full max-w-sm">
      <form action={action} className="space-y-3">
        <label className="block">
          <span className={`mb-1.5 block ${fieldLabel}`}>New password</span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className={field}
          />
        </label>

        <label className="block">
          <span className={`mb-1.5 block ${fieldLabel}`}>Type it again</span>
          <input
            name="confirm"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Same password"
            className={field}
          />
        </label>

        <div className="pt-1">
          <Submit label="Set new password" busy="Saving…" />
        </div>
      </form>

      {state.error && <Banner tone="bad">{state.error}</Banner>}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.8-2 5.1-4.4 6.7v5.5h7.1c4.1-3.8 6.6-9.5 6.6-16.2z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.3v5.7C7.9 41.1 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.7 28.2c-.4-1.3-.7-2.7-.7-4.2s.3-2.9.7-4.2v-5.7H4.3A22 22 0 0 0 2 24c0 3.6.9 6.9 2.3 9.9l7.4-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 7.9 6.9 4.3 14.1l7.4 5.7c1.7-5.2 6.6-9.1 12.3-9.1z"
      />
    </svg>
  );
}
