import { completeInstallation } from "./didar";
import { encryptSecret } from "./crypto";
import { framePage, linkPage } from "./pages";
import { startRun } from "./run";
import { Env, getCookie, iframeCookie, randomToken, text } from "./util";

// Didar Location values (list_extensions)
export const LOC = { DEALS_LIST: 1, DEAL_DETAILS: 2, PERSON_DETAILS: 4, ORG_DETAILS: 6 } as const;
export const MENU_LOCATIONS = [LOC.DEALS_LIST, LOC.DEAL_DETAILS];

// ---------- Install ----------
export async function installStart(env: Env): Promise<Response> {
  if (!env.DIDAR_INSTALLATION_URL) return text(500, "DIDAR_INSTALLATION_URL تنظیم نشده.");
  const state = randomToken(24);
  const target = new URL(env.DIDAR_INSTALLATION_URL);
  target.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Set-Cookie": `didar_install_state=${state}; Path=/didar/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

export async function installCallback(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (!code) return text(400, "کد نصب در درخواست نیست.");

  // If the flow started at /didar/install, the one-time state must match.
  const expected = getCookie(req, "didar_install_state");
  const clear = { "Set-Cookie": "didar_install_state=; Path=/didar/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax" };
  if (expected && url.searchParams.get("state") !== expected) return text(400, "درخواست نصب معتبر نیست.", clear);

  const d = await completeInstallation(env, ctx, code);
  if (!d) return text(502, "نصب کامل نشد. دوباره از لینک نصب امتحان کن.", clear);

  await env.DB.prepare(
    `INSERT INTO installations (biz_domain_id, installation_id, app_public_id, scopes, api_key_encrypted, installed_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')
     ON CONFLICT(biz_domain_id) DO UPDATE SET installation_id = excluded.installation_id, app_public_id = excluded.app_public_id,
       scopes = excluded.scopes, api_key_encrypted = excluded.api_key_encrypted, installed_at = excluded.installed_at,
       status = 'active', updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(d.BizDomainId, d.InstallationId, d.AppPublicId, JSON.stringify(d.Scopes ?? []), await encryptSecret(env.ENCRYPTION_KEY, d.ApiKey), d.InstalledAt)
    .run();

  return text(200, "نصب کامل شد. می‌توانی به دیدار برگردی.", clear);
}

// ---------- Links (Deals list + Deal details) ----------
export async function linkExtension(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const r = await startRun(req, env, ctx, "link", { target: "extension", locations: MENU_LOCATIONS });
  return r.ok ? linkPage("Hello DIDAR!") : linkPage(r.message, r.status);
}

// ---------- Custom modal (Deals list + Deal details) / Custom panel (Deal + Person details) / Settings ----------
async function iframeExtension(
  req: Request, env: Env, ctx: ExecutionContext,
  kind: "custom_modal" | "custom_panel" | "settings", target: "extension" | "settings_page", locations?: number[],
): Promise<Response> {
  const r = await startRun(req, env, ctx, kind, { target, locations });
  if (!r.ok) return framePage(env.DIDAR_ORIGIN, r.message, r.status);
  // Short server-side session (only its hash is in D1); lifetime = Runtime Token lifetime.
  return framePage(env.DIDAR_ORIGIN, "Hello DIDAR!", 200, {
    "Set-Cookie": iframeCookie("didar_run", r.run.sessionId, r.run.expiresInSeconds),
  });
}
export const customModal = (req: Request, env: Env, ctx: ExecutionContext) =>
  iframeExtension(req, env, ctx, "custom_modal", "extension", MENU_LOCATIONS);
export const customPanel = (req: Request, env: Env, ctx: ExecutionContext) =>
  iframeExtension(req, env, ctx, "custom_panel", "extension", [LOC.DEAL_DETAILS, LOC.PERSON_DETAILS]);
export const settingsPage = (req: Request, env: Env, ctx: ExecutionContext) =>
  iframeExtension(req, env, ctx, "settings", "settings_page");
