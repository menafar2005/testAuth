# didar-smart-lead

A Didar marketplace plugin (Cloudflare Worker + D1) that uses **every extension type** Didar offers.
The data model is ported from the Pipedrive `pipedrive-smart-lead-db`.

Docs it follows: https://didar-developers-docs.ehsan2005-ir.workers.dev/plugin-anatomy

## Extensions and locations

Register these in Developer Hub → **App extensions**. `BASE` = **`https://didar-smart-lead.ehsan2005-ir.workers.dev`** (deployed).

| Extension | Locations | Address field | Value | Response |
|---|---|---|---|---|
| Links | Deals list, Deal details | URL | `BASE/didar/link` | White "Hello DIDAR!" page |
| JSON modal | Deals list, Deal details | API endpoint + JSON schema | `BASE/didar/json-modal` + [`didar/json-modal.schema.json`](didar/json-modal.schema.json) | `POST` → `{ ok, message, errors?, close? }` |
| Custom modal | Entry points: Deals list, Deal details | Iframe URL | `BASE/didar/custom-modal` | White "Hello DIDAR!" iframe |
| Custom panel | Deal details, Person details | Iframe URL | `BASE/didar/custom-panel` | White "Hello DIDAR!" iframe |
| JSON panel | Organization details | API endpoint + JSON data structure | `BASE/didar/json-panel` + [`didar/json-panel.structure.json`](didar/json-panel.structure.json) | `POST` `extension.load` → `{ ok, data: { values } }` |
| App settings | Custom UI | Iframe URL | `BASE/didar/settings` | White "Hello DIDAR!" iframe |

Basic info → **Callback URL**: `BASE/didar/callback`. Scopes: **basicinfo** only, because the plugin reads nothing beyond the BizDomain info.

Capacity check: each menu location (Deals list, Deal details) has 3 menu extensions (Link + JSON modal + Custom modal), which is Didar's maximum. Each details page holds one panel. There are only 3 panel locations, so the Custom panel gets 2 of them and the JSON panel gets 1.

Every extension needs its own **JWT secret** in Developer Hub. Generate a separate 32-byte random value for each one and keep them only on the server.

### Notes on the JSON files
Both files follow Didar's "JSON extension structure v1" (https://didar-developers-docs.ehsan2005-ir.workers.dev/json-extension-schema). They validate against the official `didar-json-extension.schema.json`, which accepts no unknown keys.

- **JSON modal** (`layout: "form"`, `loadOnOpen: false`): one section with one item of each of the 11 types. The input items are `assignedUserId` (text, required), `priority` (select), `assignmentMode` (radio), `score` (number, 0–100), `followUpDate` (date), `note` (textarea) and `updateRoundRobinPointer` (checkbox). The display items are `message`, `divider`, `value` (`status`) and `link`.
- **JSON panel** (`layout: "details"`, `loadOnOpen: true`): display items only: `message`, three `value` items (`totalAssignments`, `todayAssignments`, `lastAssignment`), `divider` and `link`.
- **Compatibility**: on 2026-11-10 the live Didar app still called the JSON endpoints with `GET ?launchCode=` and no body, which is the previous contract. Both are accepted:
  - `GET` on the modal is a submit, with the values taken from the Runtime Context's `payload`.
  - `GET` on the panel is a load.
  - Replies carry both `ok` and `succeeded`. Once Didar has switched to `POST`, the `GET` branch in `src/json-ext.ts` can be removed.
- **Endpoint contract** (per the docs): Didar sends `POST` with `{ event, runtimeId, context, values }`, and CORS allows `GET, POST, OPTIONS`.
  - On `extension.submit`, `values` is re-validated against the same file on the server (required, min/max, minLength/maxLength, options, types). Invalid values return per-field `errors` without spending the launchCode.
  - The panel answers `extension.load` with `data.values`.
  - Record ids and the tenant come only from the Runtime Context. One assumption is still unconfirmed in the docs: that Didar appends `?launchCode=` to the JSON endpoint as it does for the other extensions.

## Database (D1: `didar-smart-lead-db`, id `492af856-1b55-463c-ac77-e9522bebc742`)

Schema: [`migrations/0001_init.sql`](migrations/0001_init.sql). It is already applied to the remote database.

| Pipedrive table | Didar table | What changed |
|---|---|---|
| oauth_tokens | installations | Stores the CompleteInstallation result. The ApiKey is AES-GCM encrypted. UNIQUE `biz_domain_id` |
| temprory_tokens | runtime_sessions | One row per launch. Only the SHA-256 of the token is stored, plus the trusted Runtime Context |
| user_capacities | user_capacities | `pipedrive_user_id` → `didar_user_id` (TEXT) |
| assignment_state | assignment_state | Keyed by `biz_domain_id` |
| assignment_logs | assignment_logs | Deal/user IDs are GUID TEXT. Adds `source_location` |
| webhook_events | extension_events | Didar has no webhooks, so every extension launch is logged here |
| external_api_calls | external_api_calls | Secrets, launchCodes, tokens and the ApiKey are redacted |
| rate_limits | rate_limits | Per IP + route, 60s window. Query and headers are redacted |

Throughout, `company_id INTEGER` becomes `biz_domain_id TEXT`. The BizDomain always comes from `GET /api/v1/proxy/biz-domain/info` called with the Runtime Token, never from the query string. The migration also adds the indexes the original database was missing. A daily cron deletes expired sessions, old rate-limit windows, and API logs older than 30 days.

What gets written where:
- Every launch → `runtime_sessions` + `extension_events` + `external_api_calls` + `rate_limits`
- JSON modal submit → `assignment_logs` (one row per selected deal, with `score`) and `assignment_state` (when the checkbox is checked or the mode is round-robin). All validated values are kept in `extension_events.payload`. `user_capacities` is not written by the form; the table stays in the schema.
- Install callback → `installations`
- JSON panel → reads the stats back

## Run / deploy

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run dev
```

Deploy: the repo is connected to the Worker through Cloudflare's Git integration, so every merge to `main` builds and deploys it. Don't run `wrangler deploy` by hand. Secrets are set once and survive builds:

```bash
npx wrangler secret put DIDAR_CLIENT_ID
```

```bash
npx wrangler secret put DIDAR_CLIENT_SECRET
```

```bash
npx wrangler secret put ENCRYPTION_KEY
```

```bash
npx wrangler secret put DIDAR_INSTALLATION_URL
```

`/didar/install` redirects the admin to the install link with a one-time `state`. The callback verifies that state when it exists.
