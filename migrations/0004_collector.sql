-- Talo Data, step 4: the collector (docs/DATA-ENGINE.md §5).
-- Shared tables, admin-only. Nothing here is public.

-- The source registry: what Talo checks on a schedule, how, and on what basis.
CREATE TABLE watched_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('rss', 'github_releases', 'page_watch', 'registry_listing')),
  url TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL DEFAULT '{}',
  -- Why we may read this source (public feed, documented API, terms checked…). Required.
  terms_note TEXT NOT NULL,
  -- The company this source belongs to, if known (a domain; the company may not be in Talo yet).
  company_domain TEXT,
  -- The signal type most items from this source suggest, if any.
  signal_type_hint TEXT REFERENCES signal_types(slug),
  interval_hours INTEGER NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 720),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  -- Adapter memory between runs (e.g. a page's content hash, registry keys already seen).
  state_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_watched_due ON watched_sources (enabled, next_run_at);

CREATE TABLE ingestion_runs (
  id TEXT PRIMARY KEY,
  watched_source_id TEXT NOT NULL REFERENCES watched_sources(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'not_modified', 'failed')),
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_runs_source ON ingestion_runs (watched_source_id, started_at);

-- The inbox: things the collector found. A person turns an item into a signal
-- (writing the factual claim) or dismisses it. The collector never creates signals.
CREATE TABLE collected_items (
  id TEXT PRIMARY KEY,
  watched_source_id TEXT NOT NULL REFERENCES watched_sources(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT,
  excerpt TEXT,
  suggested_signal_type TEXT REFERENCES signal_types(slug),
  suggested_domain TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'promoted', 'dismissed')),
  signal_id TEXT REFERENCES signal_events(id) ON DELETE SET NULL,
  reviewed_by TEXT,
  found_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_items_status ON collected_items (status, found_at);
