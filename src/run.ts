// Shared launch flow for every extension: exchange launchCode, resolve BizDomain, record session + event in D1.
import { didarApi, DidarError, exchangeLaunchCode, RuntimeRun } from "./didar";
import { b64urlDecodeJson, Env, nowSec, randomToken, sha256Hex } from "./util";

export type ExtensionKind = "link" | "json_modal" | "custom_modal" | "json_panel" | "custom_panel" | "settings";

export interface StartedRun extends RuntimeRun {
  bizDomainId: string;
  bizDomainTitle: string | null;
  sessionId: string; // raw value for the cookie; only its hash is stored
}

export type StartResult = { ok: true; run: StartedRun } | { ok: false; status: number; message: string };

export async function startRun(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  kind: ExtensionKind,
  expect: { target: "extension" | "settings_page"; locations?: number[] },
): Promise<StartResult> {
  const url = new URL(req.url);
  const run = await exchangeLaunchCode(env, ctx, url.searchParams.get("launchCode"));
  if (!run) return { ok: false, status: 401, message: "این اجرا معتبر نیست یا منقضی شده؛ اکستنشن را دوباره از دیدار باز کن." };

  const c = run.context;
  if (c.target !== expect.target) return { ok: false, status: 400, message: "این آدرس برای این نوع اجرا نیست." };
  if (expect.locations && (c.location == null || !expect.locations.includes(c.location))) {
    return { ok: false, status: 400, message: "این اکستنشن در این صفحه فعال نیست." };
  }

  // Tenant comes from Didar itself (basicinfo scope is always on), never from query/form.
  let biz: { Id: string; Title?: string } | null = null;
  try {
    biz = await didarApi(env, ctx, run.accessToken, "GET", "/api/v1/proxy/biz-domain/info");
  } catch (e) {
    if (!(e instanceof DidarError)) throw e;
    console.error("biz-domain/info failed", e.status, e.code, e.traceId);
    return { ok: false, status: 502, message: "اطلاعات کسب‌وکار از دیدار دریافت نشد." };
  }
  const bizDomainId = biz?.Id ?? "";

  // Decode (not verify) the token if it is a JWT, for the informational columns.
  const parts = run.accessToken.split(".");
  const header = parts.length === 3 ? b64urlDecodeJson(parts[0]) : null;
  const claims = parts.length === 3 ? b64urlDecodeJson(parts[1]) : null;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (v == null ? null : String(v));
  const userId = str(claims?.["sub"] ?? claims?.["userId"] ?? claims?.["UserId"] ?? claims?.["uid"]);

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
    ).bind(bizDomainId, c.runtimeId, kind, c.entityType, c.location, JSON.stringify(c.entityIds), JSON.stringify(c.payload).slice(0, 16000)),
  ]);

  return { ok: true, run: { ...run, bizDomainId, bizDomainTitle: biz?.Title ?? null, sessionId } };
}
