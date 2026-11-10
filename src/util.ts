export interface Env {
  DB: D1Database;
  DIDAR_CLIENT_ID: string;
  DIDAR_CLIENT_SECRET: string;
  ENCRYPTION_KEY: string;
  DIDAR_INSTALLATION_URL?: string;
  DIDAR_ORIGIN: string;
  DIDAR_APP_URL: string;
  MARKETPLACE_URL: string;
  RATE_LIMIT_PER_MINUTE?: string;
}

const enc = new TextEncoder();

export const nowIso = () => new Date().toISOString();
export const nowSec = () => Math.floor(Date.now() / 1000);

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 24): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecodeJson(part: string): Record<string, unknown> | null {
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

/** Cookie readable inside Didar's iframe (third-party context). */
export function iframeCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function text(status: number, message: string, headers: HeadersInit = {}): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---- Redaction: secrets, launchCodes and tokens never reach the DB ----
const SECRET_KEYS = new Set([
  "clientsecret", "launchcode", "state", "accesstoken", "apikey", "authorization", "cookie", "set-cookie", "token",
]);

/** `extra` adds keys for this call only (e.g. "code" in request bodies; error.code in responses stays visible). */
export function redactDeep(value: unknown, extra: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, extra));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const lk = k.toLowerCase();
      out[k] = SECRET_KEYS.has(lk) || extra.includes(lk) ? "[REDACTED]" : redactDeep(v, extra);
    }
    return out;
  }
  return value;
}

export function redactJsonText(raw: string | null | undefined, extra: string[] = [], max = 8000): string | null {
  if (raw == null || raw === "") return null;
  try {
    return JSON.stringify(redactDeep(JSON.parse(raw), extra)).slice(0, max);
  } catch {
    // Non-JSON (e.g. a Cloudflare "error code: 502" page): keep it so the real error is visible,
    // but mask anything that looks like a JWT or a long opaque token.
    return ("[text] " + maskTokens(raw)).slice(0, Math.min(max, 2000));
  }
}

export function maskTokens(s: string): string {
  return s
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[REDACTED_JWT]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[REDACTED]");
}

export function redactHeaders(h: Headers): string {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : v));
  return JSON.stringify(out);
}

export function redactedQuery(url: URL): string {
  const p = new URLSearchParams(url.search);
  for (const k of [...p.keys()]) if (SECRET_KEYS.has(k.toLowerCase()) || k.toLowerCase() === "code") p.set(k, "[REDACTED]");
  return p.toString();
}
