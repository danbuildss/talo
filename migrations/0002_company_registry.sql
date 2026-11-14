-- Talo Data, step 1: the shared company registry (docs/DATA-ENGINE.md §3).
-- Shared tables have no workspace_id: they are written only by admins and shown
-- publicly only when verified. Private workspace data links to them.

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  primary_domain TEXT NOT NULL UNIQUE,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'verified', 'rejected')),
  is_sample INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_verified_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_companies_status ON companies (status, name);

-- Every way to recognise a company, normalized. UNIQUE(kind, value) is what stops duplicates.
CREATE TABLE company_aliases (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('name', 'domain', 'github_org', 'x_handle')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, value)
);
CREATE INDEX idx_aliases_company ON company_aliases (company_id);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'technology', 'ecosystem'))
);

CREATE TABLE company_categories (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, category_id)
);
CREATE INDEX idx_company_categories_category ON company_categories (category_id);

-- Evidence documents. One row per normalized URL, ever.
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('website', 'docs', 'partner_page', 'announcement', 'rss_item',
    'github_release', 'registry_entry', 'x_post', 'directory', 'user_submitted')),
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  excerpt TEXT,
  content_hash TEXT,
  first_seen_at TEXT NOT NULL,
  last_fetched_at TEXT
);
CREATE INDEX idx_sources_company ON sources (company_id);

-- Workspace candidates point at the shared company record.
ALTER TABLE partner_candidates ADD COLUMN company_id TEXT REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX idx_candidates_company ON partner_candidates (company_id);

-- The first categories (sectors from PLAN.md §8 Phase 3, plus technologies and ecosystems).
INSERT INTO categories (id, slug, label, kind) VALUES
  ('cat-ai-agents', 'ai-agents', 'AI agents', 'sector'),
  ('cat-ai-dev-infra', 'ai-dev-infra', 'AI developer infrastructure', 'sector'),
  ('cat-wallets', 'wallets', 'Wallets', 'sector'),
  ('cat-onchain-apps', 'onchain-apps', 'Onchain apps', 'sector'),
  ('cat-payments', 'payments', 'Payments and financial infrastructure', 'sector'),
  ('cat-dev-platforms', 'dev-platforms', 'Developer platforms and APIs', 'sector'),
  ('cat-mcp', 'mcp', 'Model Context Protocol', 'technology'),
  ('cat-x402', 'x402', 'x402 payments', 'technology'),
  ('cat-llm-inference', 'llm-inference', 'LLM inference', 'technology'),
  ('cat-sdk', 'sdk', 'SDKs and libraries', 'technology'),
  ('cat-base', 'base', 'Base', 'ecosystem'),
  ('cat-ethereum', 'ethereum', 'Ethereum', 'ecosystem'),
  ('cat-solana', 'solana', 'Solana', 'ecosystem');
