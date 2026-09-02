CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO settings(key, value) VALUES ('catalog_version', '1');
INSERT OR IGNORE INTO settings(key, value) VALUES ('promoted_budget', '12');
-- optional keys (absent = default): identity_name, identity_title, identity_description, identity_instructions

CREATE TABLE IF NOT EXISTS tool_defs (
  name         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('template','http','mcp','compose')),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  spec         TEXT NOT NULL,
  annotations  TEXT NOT NULL DEFAULT '{}',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tool_overrides (
  scope       TEXT NOT NULL CHECK (scope IN ('deploy','client')),
  client_key  TEXT NOT NULL DEFAULT '',
  tool_name   TEXT NOT NULL,
  enabled     INTEGER CHECK (enabled IN (0,1)),
  promoted    INTEGER CHECK (promoted IN (0,1)),
  title       TEXT,
  description TEXT,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, client_key, tool_name)
);
CREATE INDEX IF NOT EXISTS tool_overrides_tool ON tool_overrides(tool_name);

CREATE TABLE IF NOT EXISTS upstreams (
  name        TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  auth_kind   TEXT NOT NULL CHECK (auth_kind IN ('none','bearer','secret')),
  auth_value  TEXT,
  headers     TEXT NOT NULL DEFAULT '{}',
  server_info TEXT,
  tool_cache  TEXT,
  cached_at   TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS registry_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS registry_events_at ON registry_events(at DESC);
