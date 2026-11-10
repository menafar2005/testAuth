import modalSchema from "../didar/json-modal.schema.json";
import { completeInstallation } from "./didar";
import { encryptSecret } from "./crypto";
import { framePage, linkPage } from "./pages";
import { startRun } from "./run";
import { Env, getCookie, iframeCookie, json, randomToken, text } from "./util";

// Didar Location values (list_extensions)
export const LOC = { DEALS_LIST: 1, DEAL_DETAILS: 2, PERSON_DETAILS: 4, ORG_DETAILS: 6 } as const;
const MENU_LOCATIONS = [LOC.DEALS_LIST, LOC.DEAL_DETAILS];

// ---------- CORS (JSON extensions are fetched by the browser from inside Didar) ----------
export function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.DIDAR_ORIGIN,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
const reply = (env: Env, succeeded: boolean, message: string, data?: unknown) =>
  json(data === undefined ? { succeeded, message } : { succeeded, message, data }, { headers: corsHeaders(env) });

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
  return r.ok ? linkPage("Hello Didar!") : linkPage(r.message, r.status);
}

// ---------- Custom modal (Deals list + Deal details) / Custom panel (Deal + Person details) / Settings ----------
async function iframeExtension(
  req: Request, env: Env, ctx: ExecutionContext,
  kind: "custom_modal" | "custom_panel" | "settings", target: "extension" | "settings_page", locations?: number[],
): Promise<Response> {
  const r = await startRun(req, env, ctx, kind, { target, locations });
  if (!r.ok) return framePage(env.DIDAR_ORIGIN, r.message, r.status);
  // Short server-side session (only its hash is in D1); lifetime = Runtime Token lifetime.
  return framePage(env.DIDAR_ORIGIN, "Hello Didar!", 200, {
    "Set-Cookie": iframeCookie("didar_run", r.run.sessionId, r.run.expiresInSeconds),
  });
}
export const customModal = (req: Request, env: Env, ctx: ExecutionContext) =>
  iframeExtension(req, env, ctx, "custom_modal", "extension", MENU_LOCATIONS);
export const customPanel = (req: Request, env: Env, ctx: ExecutionContext) =>
  iframeExtension(req, env, ctx, "custom_panel", "extension", [LOC.DEAL_DETAILS, LOC.PERSON_DETAILS]);
export const settingsPage = (req: Request, env: Env, ctx: ExecutionContext) =>
  iframeExtension(req, env, ctx, "settings", "settings_page");

// ---------- JSON modal (Deals list + Deal details) ----------
type Item = { type: "text" | "textarea" | "checkbox"; key: string; required?: boolean; maxLength?: number; defaultValue?: unknown };
const ITEMS: Item[] = (modalSchema.sections as { items: Item[] }[]).flatMap((s) => s.items);

/** Re-validate the payload against the same schema Didar rendered (required / type / maxLength). */
function validatePayload(payload: Record<string, unknown>): { values: Record<string, string | boolean>; error?: string } {
  const values: Record<string, string | boolean> = {};
  for (const item of ITEMS) {
    const raw = payload[item.key];
    if (item.type === "checkbox") {
      const v = raw === undefined || raw === null ? Boolean(item.defaultValue) : raw === true || raw === "true";
      if (raw !== undefined && raw !== null && typeof raw !== "boolean" && raw !== "true" && raw !== "false") {
        return { values, error: `مقدار «${item.key}» باید بله/خیر باشد.` };
      }
      if (item.required && !v) return { values, error: `«${item.key}» باید تأیید شود.` };
      values[item.key] = v;
    } else {
      if (raw !== undefined && raw !== null && typeof raw !== "string") return { values, error: `مقدار «${item.key}» باید متن باشد.` };
      const v = typeof raw === "string" ? raw.trim() : "";
      if (item.required && !v) return { values, error: `فیلد «${item.key}» الزامی است.` };
      if (item.maxLength && v.length > item.maxLength) return { values, error: `فیلد «${item.key}» حداکثر ${item.maxLength} کاراکتر است.` };
      values[item.key] = v;
    }
  }
  return { values };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const intIn = (s: string, min: number, max: number) => (/^\d+$/.test(s) && +s >= min && +s <= max ? +s : null);

export async function jsonModal(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const r = await startRun(req, env, ctx, "json_modal", { target: "extension", locations: MENU_LOCATIONS });
  if (!r.ok) return reply(env, false, r.message);
  const { context, bizDomainId } = r.run;
  if (context.entityType !== "deal" || context.entityIds.length === 0) return reply(env, false, "این فرم فقط روی معامله کار می‌کند.");

  const { values: v, error } = validatePayload(context.payload);
  if (error) return reply(env, false, error);

  const s = (k: string) => v[k] as string;
  const b = (k: string) => v[k] as boolean;
  const score = intIn(s("score"), 0, 100);
  if (score === null) return reply(env, false, "امتیاز باید عددی بین ۰ تا ۱۰۰ باشد.");
  if (s("priority") && !["low", "normal", "high"].includes(s("priority"))) return reply(env, false, "اولویت باید low، normal یا high باشد.");
  if (s("customerEmail") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s("customerEmail"))) return reply(env, false, "ایمیل مشتری معتبر نیست.");
  if (s("customerPhone") && !/^\+?[0-9\s-]{6,20}$/.test(s("customerPhone"))) return reply(env, false, "تلفن مشتری معتبر نیست.");
  if (s("estimatedBudget") && !/^\d+$/.test(s("estimatedBudget"))) return reply(env, false, "بودجه باید عدد باشد.");
  if (s("pausedUntilDate") && !DATE.test(s("pausedUntilDate"))) return reply(env, false, "تاریخ توقف باید YYYY-MM-DD باشد.");
  if (s("followUpDate") && !DATE.test(s("followUpDate"))) return reply(env, false, "تاریخ پیگیری باید YYYY-MM-DD باشد.");
  if (s("followUpTime") && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s("followUpTime"))) return reply(env, false, "ساعت پیگیری باید HH:MM باشد.");

  const stmts: D1PreparedStatement[] = context.entityIds.map((dealId) =>
    env.DB.prepare(
      `INSERT INTO assignment_logs (biz_domain_id, deal_id, assigned_user_id, assigned_user_name, score, source_location)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(bizDomainId, dealId, s("assignedUserId"), s("assignedUserName"), score, context.location),
  );

  if (b("updateRoundRobinPointer")) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO assignment_state (biz_domain_id, last_assigned_user_id) VALUES (?, ?)
         ON CONFLICT(biz_domain_id) DO UPDATE SET last_assigned_user_id = excluded.last_assigned_user_id, updated_at = CURRENT_TIMESTAMP`,
      ).bind(bizDomainId, s("assignedUserId")),
    );
  }

  if (b("saveCapacity")) {
    const daily = intIn(s("dailyCapacity"), 1, 9999);
    const order = s("sortOrder") ? intIn(s("sortOrder"), 0, 9999) : 0;
    if (daily === null) return reply(env, false, "ظرفیت روزانه باید عددی بین ۱ تا ۹۹۹۹ باشد.");
    if (order === null) return reply(env, false, "ترتیب چرخش باید عدد باشد.");
    stmts.push(
      env.DB.prepare(
        `INSERT INTO user_capacities (biz_domain_id, didar_user_id, user_name, daily_capacity, sort_order, paused_until_date, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(biz_domain_id, didar_user_id) DO UPDATE SET user_name = excluded.user_name, daily_capacity = excluded.daily_capacity,
           sort_order = excluded.sort_order, paused_until_date = excluded.paused_until_date, active = excluded.active,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(bizDomainId, s("assignedUserId"), s("assignedUserName"), daily, order, s("pausedUntilDate") || null, b("isActive") ? 1 : 0),
    );
  }

  await env.DB.batch(stmts);
  const n = context.entityIds.length;
  return reply(env, true, `${n} معامله به ${s("assignedUserName")} تخصیص داده شد.`, {
    assignedDeals: n,
    assignedUserId: s("assignedUserId"),
    score,
    roundRobinUpdated: b("updateRoundRobinPointer"),
    capacitySaved: b("saveCapacity"),
  });
}

// ---------- JSON panel (Organization details) ----------
// NOTE: Didar has not published the JSON panel request/response contract yet. This endpoint follows the
// JSON modal response contract ({ succeeded, message, data }) with data keyed by json-panel.structure.json.
export async function jsonPanel(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const r = await startRun(req, env, ctx, "json_panel", { target: "extension", locations: [LOC.ORG_DETAILS] });
  if (!r.ok) return reply(env, false, r.message);
  const biz = r.run.bizDomainId;

  const [inst, totals, today, last, team, launches, lastEvent] = await env.DB.batch<Record<string, any>>([
    env.DB.prepare(`SELECT installed_at FROM installations WHERE biz_domain_id = ?`).bind(biz),
    env.DB.prepare(`SELECT COUNT(*) AS n, ROUND(AVG(score), 1) AS avg FROM assignment_logs WHERE biz_domain_id = ?`).bind(biz),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM assignment_logs WHERE biz_domain_id = ? AND created_at >= date('now')`).bind(biz),
    env.DB.prepare(`SELECT assigned_user_name FROM assignment_logs WHERE biz_domain_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).bind(biz),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN active = 1 AND (paused_until_date IS NULL OR paused_until_date < date('now')) THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN paused_until_date >= date('now') THEN 1 ELSE 0 END) AS paused,
              SUM(CASE WHEN active = 1 THEN daily_capacity ELSE 0 END) AS capacity
       FROM user_capacities WHERE biz_domain_id = ?`,
    ).bind(biz),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM extension_events WHERE biz_domain_id = ? AND received_at >= datetime('now', '-1 day')`).bind(biz),
    env.DB.prepare(`SELECT event_action, event_object, received_at FROM extension_events WHERE biz_domain_id = ? ORDER BY id DESC LIMIT 1 OFFSET 1`).bind(biz),
  ]);

  const row = (res: D1Result<Record<string, any>>) => res.results[0] ?? {};
  const capacity = Number(row(team).capacity ?? 0);
  const todayCount = Number(row(today).n ?? 0);
  const le = row(lastEvent);
  return reply(env, true, "", {
    bizDomainTitle: r.run.bizDomainTitle ?? "",
    installedAt: row(inst).installed_at ?? "",
    totalAssignments: String(row(totals).n ?? 0),
    todayAssignments: String(todayCount),
    lastAssignedUser: row(last).assigned_user_name ?? "",
    averageScore: row(totals).avg == null ? "" : String(row(totals).avg),
    activeReps: String(row(team).active ?? 0),
    pausedReps: String(row(team).paused ?? 0),
    totalDailyCapacity: String(capacity),
    hasCapacityLeft: capacity > todayCount,
    launchesLast24h: String(row(launches).n ?? 0),
    lastEventSummary: le.event_action ? `${le.event_action} / ${le.event_object ?? "-"} @ ${le.received_at}` : "",
  });
}
