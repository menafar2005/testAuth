# didar-smart-lead

A Didar marketplace plugin (Cloudflare Worker + D1) that uses **every extension type** Didar offers.
The data model is ported from the Pipedrive `pipedrive-smart-lead-db`.

Docs it follows: https://didar-developers-docs.ehsan2005-ir.workers.dev/plugin-anatomy

## Extensions and locations

Register these in Developer Hub → **App extensions**. `BASE` = **`https://didar-smart-lead.ehsan2005-ir.workers.dev`** (deployed).

| Extension | Locations | Address field | Value | Response |
|---|---|---|---|---|
| Links | Deals list, Deal details | URL | `BASE/didar/link` | White "Hello Didar!" page |
| JSON modal | Deals list, Deal details | API endpoint + JSON schema | `BASE/didar/json-modal` + [`didar/json-modal.schema.json`](didar/json-modal.schema.json) | `{ succeeded, message, data }` |
| Custom modal | Entry points: Deals list, Deal details | Iframe URL | `BASE/didar/custom-modal` | White "Hello Didar!" iframe |
| Custom panel | Deal details, Person details | Iframe URL | `BASE/didar/custom-panel` | White "Hello Didar!" iframe |
| JSON panel | Organization details | API endpoint + JSON data structure | `BASE/didar/json-panel` + [`didar/json-panel.structure.json`](didar/json-panel.structure.json) | `{ succeeded, message, data }` (see note) |
| App settings | Custom UI | Iframe URL | `BASE/didar/settings` | White "Hello Didar!" iframe |

Basic info → **Callback URL**: `BASE/didar/callback`. Scopes: **basicinfo** only, because the plugin reads nothing beyond the BizDomain info.

Capacity check: each menu location (Deals list, Deal details) has 3 menu extensions (Link + JSON modal + Custom modal), which is Didar's maximum. Each details page holds one panel. There are only 3 panel locations, so the Custom panel gets 2 of them and the JSON panel gets 1.

Every extension needs its own **JWT secret** in Developer Hub. Generate a separate 32-byte random value for each one and keep them only on the server.

### Notes on the JSON files
- **JSON modal**: uses every schema key the docs publish (`schemaVersion`, `layout`, `title`, `description`, `loadOnOpen`, `sections[].id/title/items`, each item's `type/key/label/required/maxLength/defaultValue`, and `submit.label/closeOnSuccess/successMessage`). It also uses all three documented item types (`text`, `textarea`, `checkbox`) across 6 sections and 34 fields. Didar has not published any other field types yet, so the schema doesn't invent any.
- **JSON panel**: Didar has **not published** the "JSON data structure" format or the panel request/response contract. The structure file and endpoint are an **assumption**: they mirror the modal schema and the `{ succeeded, message, data }` contract. Check them on a test BizDomain before relying on them.

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
- JSON modal submit → `assignment_logs` (one row per selected deal), `assignment_state` (when "update pointer" is checked), `user_capacities` (when "save capacity" is checked)
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

Deploy:

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

```bash
npm run deploy
```

`/didar/install` redirects the admin to the install link with a one-time `state`. The callback verifies that state when it exists.
