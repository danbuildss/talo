-- Talo initial schema. Every table except workspaces carries workspace_id,
-- and every query in worker/db filters by it. Times are ISO-8601 UTC text.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE company_profiles (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  profile_json TEXT NOT NULL,   -- full talo.company.v1 document
  updated_at TEXT NOT NULL
);

CREATE TABLE partner_candidates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  domain TEXT NOT NULL,
  industry TEXT NOT NULL,
  partnership_type TEXT NOT NULL,
  pipeline_stage TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  mutual_benefits_json TEXT NOT NULL,
  proposed_collaboration TEXT,
  risks_json TEXT NOT NULL,
  recommended_next_action TEXT NOT NULL,
  research_timestamp TEXT NOT NULL,
  is_sample INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, domain)
);
CREATE INDEX idx_candidates_ws_stage ON partner_candidates (workspace_id, pipeline_stage);

CREATE TABLE evidence_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES partner_candidates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  accessed_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK (claim_type IN ('verified', 'inference')),
  supports_json TEXT NOT NULL
);
CREATE INDEX idx_sources_candidate ON evidence_sources (workspace_id, candidate_id);

-- One row per scoring. The latest row is the current evaluation; older rows are history.
CREATE TABLE evaluations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES partner_candidates(id) ON DELETE CASCADE,
  scores_json TEXT NOT NULL,       -- factor -> {score, reason}
  overall_score INTEGER,           -- calculated by shared/scoring.ts; NULL if a factor is unscored
  evidence_confidence TEXT NOT NULL CHECK (evidence_confidence IN ('high', 'medium', 'low')),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('ready', 'needs_verification')),
  evaluated_at TEXT NOT NULL
);
CREATE INDEX idx_evaluations_candidate ON evaluations (workspace_id, candidate_id, evaluated_at);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES partner_candidates(id) ON DELETE CASCADE,
  business_contact_name TEXT,
  business_role TEXT,
  public_contact_channel TEXT,
  source_url TEXT NOT NULL         -- public business contacts only, always with a source
);

CREATE TABLE outreach_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES partner_candidates(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  subject TEXT,
  message TEXT NOT NULL,
  recipient_json TEXT,
  personalization_sources_json TEXT NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft', 'approved', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_drafts_candidate ON outreach_drafts (workspace_id, candidate_id);

CREATE TABLE pipeline_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES partner_candidates(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('stage_change', 'note', 'activity', 'follow_up', 'imported')),
  from_stage TEXT,
  to_stage TEXT,
  notes TEXT,
  follow_up_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_candidate ON pipeline_events (workspace_id, candidate_id, created_at);
CREATE INDEX idx_events_follow_up ON pipeline_events (workspace_id, follow_up_at);

CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  input_parameters_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  usage_cost_usd REAL,
  error_details TEXT
);
