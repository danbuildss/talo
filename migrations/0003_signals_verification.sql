-- Talo Data, step 2: partnership signals and verification (docs/DATA-ENGINE.md §3–4).
-- Shared tables: admin-written, public only when verified.

CREATE TABLE signal_types (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('explicit', 'implied', 'weak')),
  freshness_days INTEGER NOT NULL CHECK (freshness_days > 0),
  description TEXT NOT NULL
);

INSERT INTO signal_types (slug, label, intent, freshness_days, description) VALUES
  ('partner_program_launched', 'Partner program launched', 'explicit', 30, 'The company opened a partner, integration or ecosystem program.'),
  ('collaboration_request', 'Collaboration request', 'explicit', 14, 'The company publicly asked for collaborators, integrations or partners.'),
  ('partnerships_role_posted', 'Partnerships role posted', 'weak', 30, 'The company is hiring for partnerships or ecosystem work.'),
  ('integration_announced', 'Integration announced', 'implied', 90, 'The company announced a new integration with another product.'),
  ('api_or_sdk_released', 'API or SDK released', 'implied', 90, 'The company released a new API, SDK or developer tool.'),
  ('product_launched', 'Product launched', 'implied', 90, 'The company launched a new product or major feature.'),
  ('ecosystem_expansion', 'Ecosystem expansion', 'implied', 90, 'The company expanded to a new chain, platform, market or ecosystem.');

-- status holds needs_review / verified / rejected. "Stale" is not stored: it is calculated
-- from last_verified_at and the type's freshness window, so it can never be out of date.
CREATE TABLE signal_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL REFERENCES signal_types(slug),
  title TEXT NOT NULL,
  factual_claim TEXT NOT NULL,
  source_excerpt TEXT NOT NULL,
  opportunity_note TEXT,
  event_date TEXT,
  discovered_at TEXT NOT NULL,
  last_verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'verified', 'rejected')),
  rejected_reason TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  is_sample INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status != 'verified' OR last_verified_at IS NOT NULL),
  CHECK (status != 'rejected' OR rejected_reason IS NOT NULL)
);
CREATE INDEX idx_signals_feed ON signal_events (status, event_date, discovered_at);
CREATE INDEX idx_signals_company ON signal_events (company_id);

CREATE TABLE signal_sources (
  signal_id TEXT NOT NULL REFERENCES signal_events(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  role TEXT NOT NULL CHECK (role IN ('primary', 'corroborating')),
  PRIMARY KEY (signal_id, source_id)
);
-- Exactly one primary source per signal (at most one here; creation always adds one).
CREATE UNIQUE INDEX idx_signal_one_primary ON signal_sources (signal_id) WHERE role = 'primary';

-- Who checked what, when, against which URL. Append-only.
CREATE TABLE verification_reviews (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('company', 'signal')),
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('verify', 'reject', 'reopen')),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  checked_url TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reviews_subject ON verification_reviews (subject_type, subject_id, created_at);

CREATE TRIGGER verification_reviews_no_update BEFORE UPDATE ON verification_reviews
BEGIN SELECT RAISE(ABORT, 'verification_reviews is append-only'); END;
CREATE TRIGGER verification_reviews_no_delete BEFORE DELETE ON verification_reviews
BEGIN SELECT RAISE(ABORT, 'verification_reviews is append-only'); END;
