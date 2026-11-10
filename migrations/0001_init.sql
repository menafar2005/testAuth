-- Didar Smart Lead: initial schema
-- Ported from the Pipedrive "pipedrive-smart-lead-db" (8 tables). Same shape, adapted to Didar:
--   company_id (INTEGER, Pipedrive)  -> biz_domain_id (TEXT, Didar GUID)
--   Pipedrive user/deal ids (INTEGER) -> Didar GUIDs (TEXT)
--   oauth_tokens     -> installations    (Didar has no OAuth refresh flow; CompleteInstallation returns an ApiKey)
--   temprory_tokens  -> runtime_sessions (short server-side session per launch; raw token is never stored)
--   webhook_events   -> extension_events (Didar has no webhooks; each extension launch is logged instead)
-- Indexes that were missing in the original DB are added at the bottom.

-- 1) Installations (one row per BizDomain). ApiKey is stored AES-GCM encrypted only.
CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_domain_id TEXT NOT NULL UNIQUE,
  biz_domain_title TEXT,
  installation_id INTEGER,
  app_public_id TEXT,
  scopes TEXT,                         -- JSON array, e.g. ["basicinfo"]
  api_key_encrypted TEXT NOT NULL,     -- base64(iv || ciphertext)
  installed_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2) Runtime sessions (was temprory_tokens). Only a SHA-256 hash of the Runtime Token is kept,
--    plus the decoded (unverified, informational) JWT header/claims and the trusted Runtime Context.
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the cookie value
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the Runtime Token
  header TEXT,
  payload TEXT,
  algorithm TEXT,
  token_type TEXT,
  user_id TEXT,
  biz_domain_id TEXT,
  runtime_id TEXT,
  target TEXT,                          -- extension | settings_page
  location INTEGER,
  entity_type TEXT,
  entity_ids TEXT,                      -- JSON array
  issued_at INTEGER,
  expires_at INTEGER NOT NULL,          -- unix seconds
  not_before INTEGER,
  jwt_id TEXT,
  token_source TEXT,                    -- link | json_modal | custom_modal | json_panel | custom_panel | settings
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  use_count INTEGER NOT NULL DEFAULT 1,
  last_request_method TEXT,
  last_request_path TEXT,
  last_request_ip TEXT,
  last_request_user_agent TEXT
);

-- 3) User capacities for lead assignment
CREATE TABLE IF NOT EXISTS user_capacities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_domain_id TEXT NOT NULL,
  didar_user_id TEXT NOT NULL,
  user_name TEXT,
  daily_capacity INTEGER NOT NULL,
  sort_order INTEGER DEFAULT 0,
  paused_until_date TEXT DEFAULT NULL,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (biz_domain_id, didar_user_id)
);

-- 4) Round-robin pointer per BizDomain
CREATE TABLE IF NOT EXISTS assignment_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_domain_id TEXT NOT NULL UNIQUE,
  last_assigned_user_id TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5) Assignment history
CREATE TABLE IF NOT EXISTS assignment_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_domain_id TEXT NOT NULL,
  deal_id TEXT NOT NULL,
  assigned_user_id TEXT NOT NULL,
  assigned_user_name TEXT,
  score INTEGER,
  source_location INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 6) Extension launches (was webhook_events)
CREATE TABLE IF NOT EXISTS extension_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_domain_id TEXT,
  runtime_id TEXT,
  event_action TEXT,     -- extension kind: link | json_modal | ...
  event_object TEXT,     -- entityType
  location INTEGER,
  entity_ids TEXT,       -- JSON array
  payload TEXT,          -- JSON (context.payload)
  received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7) Outgoing calls to Didar (secrets, launchCodes and tokens are redacted before insert)
CREATE TABLE IF NOT EXISTS external_api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_domain_id TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL,
  call_source TEXT NOT NULL DEFAULT 'backend' CHECK (call_source IN ('backend', 'frontend')),
  request_started_at DATETIME NOT NULL,
  response_received_at DATETIME,
  duration_ms INTEGER,
  request_method TEXT NOT NULL,
  request_url TEXT NOT NULL,
  request_headers TEXT,
  request_body TEXT,
  response_status INTEGER,
  response_status_text TEXT,
  response_headers TEXT,
  response_body TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  error_name TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 8) Fixed-window rate limiting. rate_key is "ip:<addr>" (before the launch is exchanged).
CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rate_key TEXT NOT NULL,
  route_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  request_received_at DATETIME,
  request_method TEXT,
  request_path TEXT,
  request_query TEXT,     -- launchCode / code / state redacted
  request_headers TEXT,   -- cookie / authorization removed
  request_ip TEXT,
  request_user_agent TEXT,
  request_content_type TEXT,
  request_country TEXT,
  UNIQUE (rate_key, route_key, window_start)
);

-- Original indexes
CREATE INDEX IF NOT EXISTS idx_external_api_calls_biz_created ON external_api_calls (biz_domain_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_api_calls_service_created ON external_api_calls (service, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_api_calls_source_created ON external_api_calls (call_source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_sessions_biz_expires ON runtime_sessions (biz_domain_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_sessions_user_expires ON runtime_sessions (user_id, expires_at DESC);

-- Added (missing in the original)
CREATE INDEX IF NOT EXISTS idx_assignment_logs_biz_user_created ON assignment_logs (biz_domain_id, assigned_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assignment_logs_biz_deal ON assignment_logs (biz_domain_id, deal_id);
CREATE INDEX IF NOT EXISTS idx_extension_events_biz_received ON extension_events (biz_domain_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start);
