import {
  corsHeaders, customModal, customPanel, installCallback, installStart, jsonModal, jsonPanel, linkExtension, settingsPage,
} from "./handlers";
import { Env, json, nowSec, redactedQuery, redactHeaders, text } from "./util";

type Handler = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

// Path -> handler. Register these exact URLs in Developer Hub.
const ROUTES: Record<string, { handler: Handler; cors?: boolean }> = {
  "/didar/install": { handler: (_r, env) => installStart(env) },
  "/didar/callback": { handler: installCallback },
  "/didar/link": { handler: linkExtension },
  "/didar/json-modal": { handler: jsonModal, cors: true },
  "/didar/custom-modal": { handler: customModal },
  "/didar/json-panel": { handler: jsonPanel, cors: true },
  "/didar/custom-panel": { handler: customPanel },
  "/didar/settings": { handler: settingsPage },
};

/** Fixed 60s window per IP+route, stored in D1 (rate_limits). Returns true when the request may continue. */
async function rateLimit(req: Request, env: Env, routeKey: string): Promise<boolean> {
  const limit = Number(env.RATE_LIMIT_PER_MINUTE ?? 120);
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const url = new URL(req.url);
  const windowStart = Math.floor(nowSec() / 60) * 60;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (rate_key, route_key, window_start, request_count, request_received_at, request_method, request_path,
       request_query, request_headers, request_ip, request_user_agent, request_content_type, request_country)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rate_key, route_key, window_start) DO UPDATE SET request_count = request_count + 1, updated_at = CURRENT_TIMESTAMP,
       request_received_at = excluded.request_received_at, request_query = excluded.request_query, request_headers = excluded.request_headers,
       request_user_agent = excluded.request_user_agent
     RETURNING request_count`,
  )
    .bind(
      `ip:${ip}`, routeKey, windowStart, req.method, url.pathname, redactedQuery(url), redactHeaders(req.headers), ip,
      req.headers.get("User-Agent"), req.headers.get("Content-Type"), (req as any).cf?.country ?? null,
    )
    .first<{ request_count: number }>();
  return (row?.request_count ?? 0) <= limit;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, app: "didar-smart-lead" });

    const route = ROUTES[url.pathname];
    if (!route) return text(404, "Not found");

    if (req.method === "OPTIONS" && route.cors) return new Response(null, { status: 204, headers: corsHeaders(env) });
    if (req.method !== "GET") return text(405, "Method not allowed", { Allow: route.cors ? "GET, OPTIONS" : "GET" });

    if (!(await rateLimit(req, env, url.pathname))) {
      return route.cors
        ? json({ succeeded: false, message: "تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره امتحان کن." }, { status: 429, headers: corsHeaders(env) })
        : text(429, "Too many requests");
    }

    try {
      return await route.handler(req, env, ctx);
    } catch (e) {
      console.error("unhandled", url.pathname, (e as Error).name, (e as Error).message);
      return route.cors
        ? json({ succeeded: false, message: "خطای داخلی پلاگین؛ دوباره امتحان کن." }, { status: 500, headers: corsHeaders(env) })
        : text(500, "Internal error");
    }
  },

  // Daily cleanup (see triggers.crons in wrangler.jsonc)
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const now = nowSec();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM runtime_sessions WHERE expires_at < ?`).bind(now - 86400),
      env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(now - 86400),
      env.DB.prepare(`DELETE FROM external_api_calls WHERE created_at < datetime('now', '-30 days')`),
    ]);
  },
} satisfies ExportedHandler<Env>;
