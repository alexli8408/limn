/**
 * Minimal CDP client for capturing the Limn demo.
 *
 * No Playwright or Puppeteer: neither is installed and both are a large install
 * for what is a dozen protocol calls. Node 22 has a global WebSocket, and Chrome
 * speaks CDP over one, so this needs nothing that is not already here.
 */

import { readFileSync } from "node:fs";

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  static async attach(wsUrl) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener("open", resolve, { once: true });
      cdp.#ws.addEventListener("error", reject, { once: true });
    });
    cdp.#ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const slot = cdp.#pending.get(msg.id);
        if (!slot) return;
        cdp.#pending.delete(msg.id);
        msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
        return;
      }
      for (const fn of cdp.#listeners.get(msg.method) ?? []) fn(msg.params);
    });
    return cdp;
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#ws.close();
  }
}

/**
 * Builds the cookie @supabase/ssr expects.
 *
 * It stores the whole session as base64 behind a "base64-" marker, and splits it
 * across numbered cookies once it passes the per-cookie size limit. The access
 * token is a JWT carrying the full user object, so a real session lands either
 * side of that limit depending on the account, and a single cookie would work on
 * one machine and silently fail on another.
 */
export function sessionCookies(ref, session, host) {
  const payload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
    expires_in: session.expires_in ?? 3600,
    token_type: session.token_type ?? "bearer",
    user: session.user,
  };
  const encoded = "base64-" + Buffer.from(JSON.stringify(payload)).toString("base64");
  const name = `sb-${ref}-auth-token`;
  const LIMIT = 3180;

  const base = { domain: host, path: "/", httpOnly: false, secure: false, sameSite: "Lax" };
  if (encoded.length <= LIMIT) return [{ ...base, name, value: encoded }];

  const chunks = [];
  for (let i = 0; i < encoded.length; i += LIMIT) chunks.push(encoded.slice(i, i + LIMIT));
  return chunks.map((value, index) => ({ ...base, name: `${name}.${index}`, value }));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
