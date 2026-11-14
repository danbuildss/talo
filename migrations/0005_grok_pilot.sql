-- Pilot A: Grok signal search (PLAN.md, approved by Dan 2026-11-14, monthly cap).
-- 1) Allow a new collector adapter, 'grok_x_search'. SQLite can't change a CHECK in place,
--    so watched_sources is rebuilt with the same columns and data.
-- 2) A spend ledger, so Talo stops itself at the monthly cap.

PRAGMA defer_foreign_keys = true;

CREATE TABLE watched_sources_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('rss', 'github_releases', 'page_watch', 'registry_listing', 'grok_x_search')),
  url TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL DEFAULT '{}',
  terms_note TEXT NOT NULL,
  company_domain TEXT,
  signal_type_hint TEXT REFERENCES signal_types(slug),
  interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 720),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO watched_sources_new SELECT id, name, adapter, url, config_json, terms_note, company_domain, signal_type_hint,
  interval_hours, enabled, next_run_at, last_success_at, last_error, consecutive_failures, etag, last_modified,
  state_json, created_by, created_at, updated_at FROM watched_sources;
DROP TABLE watched_sources;
ALTER TABLE watched_sources_new RENAME TO watched_sources;
CREATE INDEX idx_watched_due ON watched_sources (enabled, next_run_at);

-- Every paid call is recorded with Talo's cost estimate. The monthly total is checked
-- before each paid call; at the cap, paid sources are skipped until next month.
CREATE TABLE spend_ledger (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('xai', 'x_api')),
  watched_source_id TEXT REFERENCES watched_sources(id) ON DELETE SET NULL,
  posts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_spend_month ON spend_ledger (provider, created_at);
