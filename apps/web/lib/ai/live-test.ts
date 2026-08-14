/**
 * Helpers for the tests that call the real Gemini API.
 *
 * Two things make those awkward as ordinary tests. They need a key, which CI and
 * a fresh clone do not have. And the free tier allows only 20 requests per day
 * per model, so running the suite a few times exhausts it, which is a billing
 * state rather than a regression and should not turn the build red.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** vitest does not read .env, and exporting it by hand means it never gets run. */
export function loadEnv(fromDir: string): void {
  if (process.env.GEMINI_API_KEY) return;
  try {
    const text = readFileSync(resolve(fromDir, "../../../../.env"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match?.[1] && !process.env[match[1]]) process.env[match[1]] = match[2] ?? "";
    }
  } catch {
    /* no .env; callers skip */
  }
}

export const hasGeminiKey = (): boolean => Boolean(process.env.GEMINI_API_KEY);

export function isQuotaExhausted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /RESOURCE_EXHAUSTED|exceeded your current quota|Out of Gemini requests/i.test(message);
}

/** The API was never reached, so nothing about the code was exercised. */
export function isUnreachable(error: unknown): boolean {
  let node: unknown = error;
  for (let depth = 0; depth < 4 && node; depth++) {
    const e = node as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR/.test(e.code)) {
      return true;
    }
    if (typeof e.message === "string" && /socket disconnected|fetch failed|network|terminated/i.test(e.message)) {
      return true;
    }
    node = e.cause;
  }
  return false;
}

/**
 * Runs a live assertion, downgrading a spent quota to a warning.
 *
 * Deliberately narrow. Only a spent quota and an unreachable API pass through,
 * because in both cases the code under test never ran. A 404 on a withdrawn
 * model, a malformed response, or a wrong classification still fails, since
 * those are exactly what these tests exist to catch.
 */
export async function liveCheck(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (isQuotaExhausted(error)) {
      console.warn("  skipped: Gemini daily quota is spent (20/day per model on the free tier)");
      return;
    }
    if (isUnreachable(error)) {
      console.warn("  skipped: could not reach the Gemini API (network or proxy down)");
      return;
    }
    throw error;
  }
}
