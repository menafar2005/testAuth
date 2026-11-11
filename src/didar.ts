// Didar clients: marketplace (install + Runtime Token) and Didar OpenAPI (data). Every outgoing call is logged
// to external_api_calls with secrets, launchCodes, tokens and the apikey redacted.
import { Env, nowIso, redactHeaders, redactJsonText, redactUrl } from "./util";

export interface RuntimeContext {
  target: "extension" | "settings_page";
  runtimeId: string;
  location: number | null;
  entityType: "deal" | "case" | "person" | "company" | null;
  entityIds: string[];
  payload: Record<string, unknown>;
}

export interface RuntimeRun {
  accessToken: string;
  tokenType: string;
  expiresInSeconds: number;
  context: RuntimeContext;
}

export class DidarError extends Error {
  constructor(public status: number, public code: string | null, public traceId: string | null) {
    super(`Didar API ${status} ${code ?? ""}`.trim());
  }
}

async function loggedFetch(
  env: Env,
  ctx: ExecutionContext,
  service: string,
  url: string,
  init: RequestInit,
  bizDomainId = "",
): Promise<{ status: number; body: any }> {
  const started = Date.now();
  const startedIso = nowIso();
  let res: Response | null = null;
  let raw = "";
  let error: Error | null = null;
  try {
    res = await fetch(url, init);
    raw = await res.text();
  } catch (e) {
    error = e as Error;
  }

  const reqHeaders = new Headers(init.headers);
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO external_api_calls (biz_domain_id, service, call_source, request_started_at, response_received_at, duration_ms,
         request_method, request_url, request_headers, request_body, response_status, response_status_text, response_headers,
         response_body, success, error_name, error_message)
       VALUES (?, ?, 'backend', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        bizDomainId, service, startedIso, nowIso(), Date.now() - started,
        init.method ?? "GET", redactUrl(url), redactHeaders(reqHeaders), redactJsonText(init.body as string | undefined, ["code"]),
        res?.status ?? null, res?.statusText ?? null, res ? redactHeaders(res.headers) : null,
        redactJsonText(raw), res?.ok ? 1 : 0, error?.name ?? null, error?.message ?? null,
      )
      .run()
      .catch((e) => console.error("external_api_calls insert failed", e)),
  );

  if (error) throw error;
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res!.status, body };
}

/** launchCode -> Runtime Token + Runtime Context. null when the code is invalid/expired/used. */
export async function exchangeLaunchCode(env: Env, ctx: ExecutionContext, launchCode: string | null): Promise<RuntimeRun | null> {
  if (!launchCode) return null;
  const { status, body } = await loggedFetch(env, ctx, "didar.runtime_token", `${env.MARKETPLACE_URL}/api/v1/runtime/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ launchCode, clientId: env.DIDAR_CLIENT_ID, clientSecret: env.DIDAR_CLIENT_SECRET }),
  });
  if (status < 200 || status >= 300 || !body?.succeeded) {
    console.error("launch exchange failed", status, body?.error?.code, body?.meta?.traceId);
    return null;
  }
  const data = body.data as RuntimeRun;
  data.context.entityIds ??= [];
  data.context.payload ??= {};
  return data;
}

/**
 * Didar OpenAPI (https://developers.didar.me): POST https://app.didar.me<path>?apikey=DIDAR_API_KEY, result under `Response`.
 * Replaces the marketplace data proxy (marketplace.didar.me/api/v1/proxy/...). The apikey is masked in logs.
 */
export async function didarOpenApi<T = any>(env: Env, ctx: ExecutionContext, path: string, payload?: unknown, bizDomainId = ""): Promise<T> {
  if (!env.DIDAR_API_KEY) throw new DidarError(0, "DIDAR_API_KEY_MISSING", null);
  const url = `${env.DIDAR_APP_URL}${path}?apikey=${encodeURIComponent(env.DIDAR_API_KEY)}`;
  const { status, body } = await loggedFetch(env, ctx, `didar.openapi POST ${path}`, url, {
    method: "POST",
    headers: payload === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }, bizDomainId);
  if (status < 200 || status >= 300 || !body || !("Response" in body)) throw new DidarError(status, null, null);
  return body.Response as T;
}

export interface InstallationData {
  InstallationId: number;
  AppPublicId: string;
  BizDomainId: string;
  ApiKey: string;
  Scopes: string[];
  InstalledAt: string;
}

/** CompleteInstallation on app.didar.me (PascalCase body, result under Response). */
export async function completeInstallation(env: Env, ctx: ExecutionContext, code: string): Promise<InstallationData | null> {
  const { status, body } = await loggedFetch(env, ctx, "didar.complete_installation", `${env.DIDAR_APP_URL}/api/MarketplaceInstall/CompleteInstallation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Code: code, ClientId: env.DIDAR_CLIENT_ID, ClientSecret: env.DIDAR_CLIENT_SECRET }),
  });
  const result = body?.Response;
  if (status < 200 || status >= 300 || !result?.Succeeded) {
    console.error("install failed", status, JSON.stringify(result?.Error ?? null), result?.Meta?.TraceId);
    return null;
  }
  return result.Data as InstallationData;
}
