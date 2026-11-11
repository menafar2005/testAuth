// Shared launch flow for every extension: exchange launchCode, resolve BizDomain, record session + event in D1.
import { DidarError, didarOpenApi, exchangeLaunchCode, RuntimeRun } from "./didar";
import { b64urlDecodeJson, Env, nowSec, randomToken, sha256Hex } from "./util";

export type ExtensionKind = "link" | "json_modal" | "custom_modal" | "json_panel" | "custom_panel" | "settings";

export interface StartedRun extends RuntimeRun {
  bizDomainId: string | null; // null when neither the token nor the Didar OpenAPI gave the tenant
  bizDomainTitle: string | null; // the Didar OpenAPI has no BizDomain-info endpoint, so this stays null
  sessionId: string; // raw value for the cookie; only its hash is stored
}

export type StartResult = { ok: true; run: StartedRun } | { ok: false; status: number; message: string };

export async function startRun(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  kind: ExtensionKind,
  expect: { target: "extension" | "settings_page"; locations?: number[] },
  loggedPayload?: unknown, // validated JSON-extension values; defaults to context.payload
): Promise<StartResult> {
  const url = new URL(req.url);
  const run = await exchangeLaunchCode(env, ctx, url.searchParams.get("launchCode"));
  if (!run) return { ok: false, status: 401, message: "این اجرا معتبر نیست یا منقضی شده؛ اکستنشن را دوباره از دیدار باز کن." };

  const c = run.context;
  if (c.target !== expect.target) return { ok: false, status: 400, message: "این آدرس برای این نوع اجرا نیست." };
  if (expect.locations && (c.location == null || !expect.locations.includes(c.location))) {
    return { ok: false, status: 400, message: "این اکستنشن در این صفحه فعال نیست." };
  }

  // Decode the token if it is a JWT. It came straight from the marketplace in exchange for our client
  // secret, so its claims are as trustworthy as the context (the signature is not verified here).
  const parts = run.accessToken.split(".");
  const header = parts.length === 3 ? b64urlDecodeJson(parts[0]) : null;
  const claims = parts.length === 3 ? b64urlDecodeJson(parts[1]) : null;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (v == null ? null : String(v));
  const userId = str(claims?.["sub"] ?? claims?.["userId"] ?? claims?.["UserId"] ?? claims?.["uid"]);

  // Tenant, never from query/form: 1) a BizDomain claim in the token, 2) the Didar OpenAPI (DIDAR_API_KEY).
  // If both fail the run continues with bizDomainId = null; handlers that write tenant data must check it.
  const bizDomainId = bizDomainClaim(claims) ?? (await fetchBizDomainId(env, ctx));
  const bizDomainTitle: string | null = null;

  const sessionId = randomToken(24);
  const expiresAt = nowSec() + run.expiresInSeconds;
  const ip = req.headers.get("CF-Connecting-IP");
  const ua = req.headers.get("User-Agent");

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runtime_sessions (session_id_hash, token_hash, header, payload, algorithm, token_type, user_id, biz_domain_id,
         runtime_id, target, location, entity_type, entity_ids, issued_at, expires_at, not_before, jwt_id, token_source,
         last_request_method, last_request_path, last_request_ip, last_request_user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(token_hash) DO UPDATE SET use_count = use_count + 1, last_seen_at = CURRENT_TIMESTAMP`,
    ).bind(
      await sha256Hex(sessionId), await sha256Hex(run.accessToken),
      header ? JSON.stringify(header) : null, claims ? JSON.stringify(claims) : null,
      str(header?.["alg"]), run.tokenType ?? str(header?.["typ"]), userId, bizDomainId,
      c.runtimeId, c.target, c.location, c.entityType, JSON.stringify(c.entityIds),
      num(claims?.["iat"]), expiresAt, num(claims?.["nbf"]), str(claims?.["jti"]), kind,
      req.method, url.pathname, ip, ua,
    ),
    env.DB.prepare(
      `INSERT INTO extension_events (biz_domain_id, runtime_id, event_action, event_object, location, entity_ids, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(bizDomainId, c.runtimeId, kind, c.entityType, c.location, JSON.stringify(c.entityIds), JSON.stringify(loggedPayload ?? c.payload).slice(0, 16000)),
  ]);

  return { ok: true, run: { ...run, bizDomainId, bizDomainTitle, sessionId } };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** First claim whose name contains "bizdomain" (any case/separator) and whose value is a GUID. */
function bizDomainClaim(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null;
  for (const [k, v] of Object.entries(claims)) {
    if (k.toLowerCase().replace(/[^a-z]/g, "").includes("bizdomain") && typeof v === "string" && GUID.test(v)) return v;
  }
  return null;
}

// The Didar OpenAPI has no BizDomain-info endpoint (the marketplace's /api/v1/proxy/biz-domain/info has no
// equivalent there). These reference lists carry BizDomainId on every item; the first non-empty one wins.
// https://developers.didar.me/Lost-Reasons · /Tags · /Get-Custom-Fields
const BIZ_DOMAIN_SOURCES = ["/api/Deal/GetLostReasons", "/api/Tag/GetTagList", "/api/customfield/GetCustomfieldList"];

export async function fetchBizDomainId(env: Env, ctx: ExecutionContext): Promise<string | null> {
  for (const path of BIZ_DOMAIN_SOURCES) {
    try {
      const res = await didarOpenApi<unknown>(env, ctx, path);
      // Lost reasons / tags are arrays; custom fields are an object keyed by field id.
      const items = Array.isArray(res) ? res : res && typeof res === "object" ? Object.values(res) : [];
      const id = (items as { BizDomainId?: unknown }[]).find((i) => typeof i?.BizDomainId === "string" && GUID.test(i.BizDomainId))?.BizDomainId;
      if (typeof id === "string") return id;
    } catch (e) {
      if (!(e instanceof DidarError)) throw e;
      console.error("didar openapi failed", path, e.status, e.code);
      if (e.code === "DIDAR_API_KEY_MISSING" || e.status === 401) return null; // same result for every source
    }
  }
  return null;
}
