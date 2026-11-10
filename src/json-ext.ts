// JSON modal + JSON panel endpoints (contract: https://didar-developers-docs.ehsan2005-ir.workers.dev/api-app-endpoints#json-extension)
// Didar calls the API endpoint with POST + JSON body { event, runtimeId, context, values }:
//   extension.load   -> reply { ok, data: { values } }        (only when the structure has loadOnOpen: true)
//   extension.submit -> reply { ok, message, errors?, close? } (forms only)
// The body comes from the browser, so record ids and tenant come only from the Runtime Context (launchCode in the URL).
// Assumption flagged in the docs: Didar appends ?launchCode= to the endpoint like for other extensions.
import modalSchema from "../didar/json-modal.schema.json";
import { LOC, MENU_LOCATIONS } from "./handlers";
import { startRun } from "./run";
import { Env, json } from "./util";

export function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.DIDAR_ORIGIN,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

type JsonReply = { ok: boolean; message?: string; errors?: Record<string, string>; close?: boolean; data?: { values: Record<string, unknown> } };
export const jsonReply = (env: Env, body: JsonReply, status = 200) => json(body, { status, headers: corsHeaders(env) });

interface JsonRequest {
  event?: string;
  runtimeId?: string;
  context?: { location?: number; locale?: string; entityId?: string; entityIds?: string[]; allSelected?: boolean };
  values?: Record<string, unknown>;
}

async function readBody(req: Request): Promise<JsonRequest | null> {
  const raw = await req.text();
  if (raw.length > 64 * 1024) return null;
  try {
    const body = JSON.parse(raw);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// ---------- Validation driven by the same structure file Didar renders ----------
type Text = string | Record<string, string>;
interface Item {
  type: string;
  key?: string;
  label?: Text;
  required?: boolean;
  readOnly?: boolean;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  options?: { label: Text; value: string | number | boolean }[];
}
const INPUT_TYPES = new Set(["text", "textarea", "number", "date", "select", "radio", "checkbox"]);
const allItems = (doc: { sections: { items: Item[] }[] }) => doc.sections.flatMap((s) => s.items);
const MODAL_ITEMS = allItems(modalSchema as never).filter((i) => INPUT_TYPES.has(i.type) && i.key);

const fa = (t: Text | undefined, fallback: string) => (typeof t === "string" ? t : t?.fa ?? t?.en ?? fallback);

/** Server-side re-validation of submit values (Didar's UI checks are not a security boundary). */
export function validateValues(items: Item[], input: Record<string, unknown>) {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const it of items) {
    const key = it.key!;
    const name = fa(it.label, key);
    let raw = it.readOnly ? it.defaultValue : input[key];
    const empty = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
    if (empty) {
      if (it.required && !(it.type === "checkbox")) errors[key] = `«${name}» الزامی است.`;
      raw = it.defaultValue ?? (it.type === "checkbox" ? false : null);
      if (it.type === "checkbox" && it.required && raw !== true) errors[key] = `«${name}» باید تأیید شود.`;
      values[key] = raw;
      continue;
    }
    switch (it.type) {
      case "text":
      case "textarea": {
        if (typeof raw !== "string") { errors[key] = `«${name}» باید متن باشد.`; break; }
        const v = raw.trim();
        if (it.minLength != null && v.length < it.minLength) errors[key] = `«${name}» حداقل ${it.minLength} کاراکتر است.`;
        else if (it.maxLength != null && v.length > it.maxLength) errors[key] = `«${name}» حداکثر ${it.maxLength} کاراکتر است.`;
        values[key] = v;
        break;
      }
      case "number": {
        const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
        if (!Number.isFinite(n)) errors[key] = `«${name}» باید عدد باشد.`;
        else if (it.min != null && n < it.min) errors[key] = `«${name}» نباید کمتر از ${it.min} باشد.`;
        else if (it.max != null && n > it.max) errors[key] = `«${name}» نباید بیشتر از ${it.max} باشد.`;
        values[key] = n;
        break;
      }
      case "date": {
        // Didar has not published the date value format; accept any string Date can parse and keep it as sent.
        if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) errors[key] = `«${name}» تاریخ معتبر نیست.`;
        values[key] = raw;
        break;
      }
      case "select":
      case "radio": {
        if (!(it.options ?? []).some((o) => o.value === raw)) errors[key] = `مقدار «${name}» در گزینه‌ها نیست.`;
        values[key] = raw;
        break;
      }
      case "checkbox": {
        const b = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : null;
        if (b === null) errors[key] = `«${name}» باید بله یا خیر باشد.`;
        else if (it.required && !b) errors[key] = `«${name}» باید تأیید شود.`;
        values[key] = b;
        break;
      }
    }
  }
  return { values, errors };
}

const INVALID_RUN = "این اجرا معتبر نیست یا منقضی شده؛ اکستنشن را دوباره از دیدار باز کن.";
const NO_TENANT = "اطلاعات کسب‌وکار از دیدار دریافت نشد؛ کمی بعد دوباره امتحان کن.";

// ---------- JSON modal (Deals list + Deal details) ----------
export async function jsonModal(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readBody(req);
  if (!body) return jsonReply(env, { ok: false, message: "بدنه‌ی درخواست JSON معتبر نیست." }, 400);

  if (body.event === "extension.load") {
    // loadOnOpen is false in json-modal.schema.json; answer anyway with the defaults (no launchCode is consumed).
    return jsonReply(env, { ok: true, data: { values: { status: "New" } } });
  }
  if (body.event !== "extension.submit") return jsonReply(env, { ok: false, message: "درخواست ناشناخته است." });

  // Field errors first, so the user can fix them without spending the launchCode.
  const { values: v, errors } = validateValues(MODAL_ITEMS, body.values ?? {});
  if (Object.keys(errors).length) return jsonReply(env, { ok: false, message: "بعضی از مقادیر معتبر نیستند.", errors });

  const r = await startRun(req, env, ctx, "json_modal", { target: "extension", locations: MENU_LOCATIONS }, v);
  if (!r.ok) return jsonReply(env, { ok: false, message: r.message });
  const { context, bizDomainId } = r.run;
  if (!bizDomainId) return jsonReply(env, { ok: false, message: NO_TENANT });
  if (context.entityType !== "deal" || context.entityIds.length === 0) {
    return jsonReply(env, { ok: false, message: "این فرم فقط روی معامله کار می‌کند." });
  }

  const userId = v.assignedUserId as string;
  const movePointer = v.updateRoundRobinPointer === true || v.assignmentMode === "round_robin";
  const stmts: D1PreparedStatement[] = context.entityIds.map((dealId) =>
    env.DB.prepare(
      `INSERT INTO assignment_logs (biz_domain_id, deal_id, assigned_user_id, score, source_location) VALUES (?, ?, ?, ?, ?)`,
    ).bind(bizDomainId, dealId, userId, v.score as number | null, context.location),
  );
  if (movePointer) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO assignment_state (biz_domain_id, last_assigned_user_id) VALUES (?, ?)
         ON CONFLICT(biz_domain_id) DO UPDATE SET last_assigned_user_id = excluded.last_assigned_user_id, updated_at = CURRENT_TIMESTAMP`,
      ).bind(bizDomainId, userId),
    );
  }
  await env.DB.batch(stmts);

  const n = context.entityIds.length;
  return jsonReply(env, { ok: true, message: `${n} معامله به کارشناس ${userId} تخصیص داده شد.`, close: true });
}

// ---------- JSON panel (Organization details), layout "details" ----------
export async function jsonPanel(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readBody(req);
  if (!body) return jsonReply(env, { ok: false, message: "بدنه‌ی درخواست JSON معتبر نیست." }, 400);
  if (body.event !== "extension.load") return jsonReply(env, { ok: false, message: "این پنل فقط extension.load را می‌پذیرد." });

  const r = await startRun(req, env, ctx, "json_panel", { target: "extension", locations: [LOC.ORG_DETAILS] });
  if (!r.ok) return jsonReply(env, { ok: false, message: r.message || INVALID_RUN });
  const biz = r.run.bizDomainId;
  if (!biz) return jsonReply(env, { ok: false, message: NO_TENANT });

  const [totals, today, last] = await env.DB.batch<Record<string, any>>([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM assignment_logs WHERE biz_domain_id = ?`).bind(biz),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM assignment_logs WHERE biz_domain_id = ? AND created_at >= date('now')`).bind(biz),
    env.DB.prepare(
      `SELECT assigned_user_id, deal_id, created_at FROM assignment_logs WHERE biz_domain_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).bind(biz),
  ]);
  const row = (res: D1Result<Record<string, any>>) => res.results[0] ?? {};
  const l = row(last);

  // Keys match the `value` items in json-panel.structure.json
  return jsonReply(env, {
    ok: true,
    data: {
      values: {
        totalAssignments: String(row(totals).n ?? 0),
        todayAssignments: String(row(today).n ?? 0),
        lastAssignment: l.deal_id ? `${l.assigned_user_id} — ${l.created_at}` : "—",
      },
    },
  });
}
