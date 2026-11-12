# Talo — Build Plan

> **talo.** The intelligence behind better partnerships. *Better partnerships start here.*

This is the plan everything is built from. It is derived from the *Talo Master Product, Business & Engineering Blueprint v1.0* (November 2026). Where other notes disagree, this file wins. Changes to it go through the normal loop: sketch, approve, PR.

---

## 1. Product direction

### What Talo is
A tool that helps a company answer five questions about partnerships:
1. Who should we partner with?
2. Why would that company benefit from working with us?
3. What could we realistically build or do together?
4. How do we approach the right people?
5. How do we turn that conversation into an actual partnership?

The one workflow we build: **understand the company → find relevant partners → evaluate mutual value → prepare a credible approach → track progress.**

Every recommendation explains what **each side** gains and links to its sources. Ten strong, verified candidates beat 500 weak ones.

### Who it's for (V1)
Early-stage AI, Web3, API, agent-infrastructure and developer-tool companies that already have a working product, need integrations or distribution, and have a founder or small team doing partnerships without a dedicated BD hire.

V1 focuses on two partnership types: **product and technology integrations** and **distribution and co-marketing**. Ecosystem, channel/referral and creator partnerships exist as categories but get no special features yet.

### How it's sold (V1)
Service first, software second. Somehow Business delivers the work, and Talo is the internal tool used to deliver it.
- **Partnership Snapshot** (free sample): company analysis plus 3 candidates with a short rationale.
- **Opportunity Map** (paid): 8–10 evidence-backed candidates, fit analysis, mutual value, strategy and suggested outreach.
- **30-Day Partnership Sprint** (paid, managed): the Map plus outreach preparation, tracking and outcome reporting.
- **Ongoing Partnership Intelligence**: tests whether there's recurring demand.

Pricing isn't set until we've done customer interviews and measured what a report costs to deliver.

### Brand structure
Wordmark **talo.** · descriptor *Partnership Intelligence* · endorsement *by Somehow Internet*. Hierarchy: Somehow Internet → Somehow Business → Talo. Contracts sit with whichever registered entity Dan names; the brand isn't assumed to be a legal company.

### What Talo is not (V1)
Not a general AI assistant · not bulk lead generation or email harvesting · not an X DM bot or any auto-sender · not a CRM replacement · not an enterprise PRM suite · not a marketplace · not an always-on agent swarm · not a self-service subscription · not a GTMQuant clone (we can study its workflow, never copy its design, art or copy).

---

## 2. MVP scope (the private app, Phase 3)

### In
| # | Feature | Done when |
|---|---|---|
| M1 | Admin-only access | Every app and API route rejects anyone who isn't an approved admin, checked on the server. |
| M2 | Company profile | Create and edit the client's profile (fields in §4). Saved and survives a refresh. |
| M3 | Candidate import | Upload a JSON or CSV file in the Talo candidate format; bad rows are rejected with clear reasons; nothing is half-imported. |
| M4 | Duplicate detection | Same normalized domain in the same workspace is flagged on import and in the list. |
| M5 | Candidate list | Search, filter by stage, type, score and verification status; sort by score. |
| M6 | Candidate detail | Overview, evidence with source links and dates, score breakdown with reasons, thesis, mutual value, risks, next action. Editable. |
| M7 | Fit scoring | Calculated by the formula in §5. Shows each factor's score, weight and reason. "Needs verification" when evidence is thin. |
| M8 | Outreach drafts | Create, edit and save drafts per channel (email, X DM, Telegram, proposal, follow-up). Approval status: draft → approved. **No sending.** |
| M9 | Pipeline | Move candidates through stages; log notes, activities and follow-up dates. |
| M10 | Export | Export a workspace's data as JSON and CSV. A printable Opportunity Map view. |
| M11 | Quality basics | Usable on a phone; empty, loading and error states; sample data clearly labelled; no secrets in the frontend bundle. |

### Out (explicitly)
Live AI research inside the app · AI API calls of any kind · automatic sending · public sign-up and customer accounts · payments · search-API integrations · X/Grok signal monitoring · Telegram notifications · teams and roles · public landing page (see Phase 2 decision) · analytics dashboards.

Phase 1 research happens with Claude **outside** the app and comes in through import (M3). The app does not pretend to research.

---

## 3. Architecture and tech stack

### Principles
Small, boring, free. One deployable. Few dependencies. Server decides everything about access. Nothing runs continuously.

### Stack
| Layer | Choice | Why |
|---|---|---|
| Frontend | React + TypeScript + Vite + Tailwind CSS | Mainstream, well documented, easy for Claude to maintain. |
| Backend | One Cloudflare Worker serving the API and the built frontend, using the official Cloudflare Vite plugin | One thing to deploy; free tier; no server to babysit. |
| Routing / validation | Hono (tiny router) + Zod (input validation) | Both are small, typed and standard on Workers. Shared Zod schemas validate imports on both sides. |
| Database | Cloudflare D1 (SQLite), versioned SQL migrations via Wrangler | Free tier, no separate host. |
| Access | Cloudflare Access (Zero Trust) in front of the app **and** the Worker verifies the Access token on every API request | Free tier covers a small number of users (to be confirmed against current terms). The double check means a misconfigured dashboard rule doesn't expose data. |
| Tests | Vitest; Worker tests run in the Workers runtime (`@cloudflare/vitest-pool-workers`); one Playwright check per main screen at phone and desktop width | Tests run against real D1 behaviour locally. |
| Code | GitHub repo `danbuildss/talo` | Dan merges every PR. |

Free-tier limits (requests, D1 size, Access seats) are checked against Cloudflare's current terms before Phase 3 starts and recorded in `docs/DECISIONS.md`.

### Shape of the code (proposed, adapted to current Cloudflare templates)
```
talo/
├── CLAUDE.md  PLAN.md  README.md
├── brand/BRAND.md
├── docs/DECISIONS.md  docs/RESEARCH-METHODOLOGY.md
├── skills/                 # the four Claude research skills (Phase 1)
│   ├── company-intelligence/SKILL.md
│   ├── partnership-scout/SKILL.md
│   ├── partnership-strategist/SKILL.md
│   └── outreach-specialist/SKILL.md
├── schemas/                # JSON Schemas for skill output = app import format
├── src/                    # React app
├── worker/                 # API routes, auth middleware, db access
├── migrations/             # D1 SQL migrations
├── shared/                 # types, Zod schemas, scoring formula (used by app, worker and tests)
└── tests/
```
`PLAN.md` replaces the blueprint's separate PRODUCT / ARCHITECTURE / ROADMAP docs so there's one source of truth.

### The AI line (important)
Building Talo with Claude doesn't give the deployed app a free AI. In Phases 1–4: people collect sources, Claude helps analyse them in a chat session using the skills, the structured result is imported, and Talo stores, scores, displays and tracks it. Live AI inside the app is a separate, paid decision (Phase 5).

---

## 4. Domain model

Every table except `workspaces` carries `workspace_id`, and every query filters by it. IDs are random (UUIDs). Times are ISO-8601 UTC.

```
workspace ─┬─ company_profile (1)
           ├─ research_run (many)
           └─ partner_candidate (many) ─┬─ evidence_source (many)
                                        ├─ evaluation (many; latest is current)
                                        ├─ contact (0..few)
                                        ├─ outreach_draft (many)
                                        └─ pipeline_event (many)
```

| Table | Key fields |
|---|---|
| `workspaces` | id, name, owner_id, is_sample, created_at |
| `company_profiles` | id, workspace_id, name, website, summary, sector, target_audience, stage, existing_partners, geographies, partnership_goals, partner_types_wanted, partner_types_excluded, updated_at |
| `partner_candidates` | id, workspace_id, company_name, domain (normalized, **unique per workspace**), sector, partnership_type, current_stage, verification_status, research_run_id, created_at, updated_at |
| `evidence_sources` | id, workspace_id, candidate_id, url, source_title, source_date, accessed_at, evidence_summary, claim_type (`verified` / `inference`), verification_status |
| `evaluations` | id, workspace_id, candidate_id, score_components (JSON: factor → score + reason), overall_score, evidence_confidence, mutual_value (JSON: for_client, for_partner), proposed_collaboration, risks, recommendation, evaluated_at |
| `contacts` | id, workspace_id, candidate_id, business_contact_name, business_role, public_contact_channel, source_url — **only public business contacts with a source**; no personal phone numbers or private emails |
| `outreach_drafts` | id, workspace_id, candidate_id, channel, subject, message, approval_status (`draft` / `approved` / `archived`), created_at, updated_at |
| `pipeline_events` | id, workspace_id, candidate_id, event_type (`stage_change` / `note` / `activity` / `follow_up`), from_stage, to_stage, notes, follow_up_at, created_at |
| `research_runs` | id, workspace_id, input_parameters, status, started_at, completed_at, usage_cost, error_details |

**Pipeline stages:** Discovered → Researched → Qualified → Outreach Prepared → Contacted → Replied → In Discussion → Proposal → Partnered. Side states: Not a fit · Declined · On hold · Archived.

**Later, not now:** `memberships` (user, workspace, role) for multi-user. Designed for, not built.

---

## 5. Research method and scoring

### Evidence standard
- Every factual claim about a candidate links to a source with an access date (and publication date if known).
- Sources allowed: official sites, developer docs, public partner pages, public ecosystem directories, official announcements, public X posts viewed by permitted means, permitted APIs, links supplied by Dan or the client.
- Claims are tagged **verified** (directly stated by a source) or **inference** (our reasoning). Inferences never appear as facts.
- No invented names, emails, job titles or relationships. No contact without a public source.

### Fit score (deterministic)
Each factor gets a 0–5 score **and a one-sentence reason**:

| Factor | Weight |
|---|---:|
| Product and audience alignment | 30% |
| Mutual commercial value | 25% |
| Partnership readiness | 20% |
| Contact accessibility | 15% |
| Execution feasibility | 10% |

`overall = round( Σ (score ÷ 5 × weight) × 100 )` → 0–100. Code computes it, not the model.

### Evidence confidence (separate from fit)
- **High:** every factor rests on at least one verified source, and at least two independent sources overall, all accessed within the last 90 days.
- **Medium:** every factor has a reason, and at least one verified source supports alignment and readiness.
- **Low:** anything less.

**"Needs verification"** is shown instead of a headline score when confidence is Low or any factor is unscored. A high score means *research-based compatibility*, never a promise of a reply or a deal; the UI says so.

### Rejection rules (the strategist must apply them)
A candidate is marked *Not a fit* if: no plausible benefit for the partner; direct competitor; in an excluded type or geography; no verifiable public presence; or the only "fit" is that both are in the same broad sector.

Full detail goes in `docs/RESEARCH-METHODOLOGY.md` (Phase 1).

---

## 6. The four research skills

Plain Claude skills (`skills/*/SKILL.md`), run one after another in a chat session. No servers or subscriptions. Each outputs JSON that matches a schema in `schemas/`; the strategist's output is exactly what the app imports.

| Skill | Input | Output (summary) |
|---|---|---|
| **A. Company Intelligence** | Client website, product summary, segment, goals | Profile, capabilities, target users, partnership types, competitive context, strengths and limits, **open questions to confirm**. Verified vs inferred marked. |
| **B. Partnership Scout** | A's output + objective | Candidates: name, domain, category, source URLs, signals, collaboration angle, research timestamp, initial confidence. Relevance over volume. |
| **C. Partnership Strategist** | A + B | Factor scores with reasons, mutual value (both sides), feasibility, objections, proposed collaboration, what to verify, next step. **Rejects weak matches.** |
| **D. Outreach Specialist** | Approved candidate + strategy + channel + voice | Short opener, alternative angle, follow-up, optional proposal, suggested pipeline stage. Specific, honest, no false familiarity. |

Candidate record (minimum): candidate_id, workspace_id, company_name, domain, industry, partnership_category, sources[] {url, title, published_at, accessed_at, summary, claim_type}, research_timestamp, evidence_summary, score_components{}, overall_score (computed on import), evidence_confidence, mutual_benefits{for_client, for_partner}, risks[], recommended_next_action, verification_status, pipeline_stage.

---

## 7. Security and privacy plan

- Repo private (to confirm). No secrets in code; `.dev.vars` and `.wrangler/` git-ignored.
- Cloudflare Access protects the whole app; the Worker also verifies the Access JWT (signature, audience, issuer) on every `/api` request and checks the email against an admin allowlist. Fails closed.
- Every database query is parameterized and scoped by `workspace_id`; a test proves one workspace can't read another's data.
- All input validated with Zod on the server. React escapes output; no raw HTML from imported data; source links open with `rel="noopener noreferrer"` and only `http(s)` URLs are accepted.
- Security headers (CSP, frame-ancestors none, no-sniff).
- Errors are logged without client data or secrets.
- Backups: `wrangler d1 export` script plus the in-app JSON export. Workspace delete exists before any external customer gets access.
- Client research isn't sent to outside AI services without the client's permission. Talo's data isn't mixed with other businesses'.
- Store the minimum contact data: business role and public channel only.

---

## 8. Phases

Each phase is tested before the next begins. Day counts are targets, not deadlines.

### Phase 0 — Foundation (days 1–3)
Deliverables, each a small PR: this `PLAN.md` and `CLAUDE.md` · `brand/BRAND.md` · `docs/DECISIONS.md` · Opportunity Map template · naming due-diligence checklist (talo.com and talo.club already exist; trademark search in Dan's jurisdictions; no domains or handles bought or claimed until cleared).
**Done when:** we can say in one paragraph what Talo does, who needs it and what they get, and Dan has approved it.

### Phase 1 — Research skills (days 4–7)
The four skills, their JSON schemas, `docs/RESEARCH-METHODOLOGY.md`. Test on one real company using public sources: research about 15 candidates, verify, keep the best 5. Log time per step and how many candidates failed verification.
**Done when:** the brief is useful and someone other than us can check every claim from its links.

### Phase 2 — Client Zero (days 8–21)
Dan recruits 1–3 suitable companies. Free or reduced diagnostic, aiming for a paid Map or Sprint. No unlimited free consulting. Per client: intake → 30–50 researched → 8–10 recommended → strategy → which would they really pursue → track approved outreach → ask for payment for a defined next step. Measure acceptance, research time, new discoveries, outreach sent, qualified replies, willingness to pay.
Claude prepares intake forms, briefs and DM drafts; Dan does all outreach.
**Done when:** a customer pays, or we have concrete evidence of why they won't.

### Phase 3 — Private MVP (weeks 3–5, shaped by Phase 2)
Features M1–M11 (§2), deployed on Cloudflare free tier, as a series of small PRs:
1. Project skeleton (Vite + Worker + Tailwind + tests + CI build) with a placeholder page.
2. D1 migrations + typed data access + workspace-isolation test.
3. Access protection + server-side JWT check.
4. Company profile.
5. Shared schemas + scoring formula + tests.
6. Candidate import with validation and duplicate detection.
7. Candidate list (search/filter) and detail.
8. Outreach drafts.
9. Pipeline and follow-ups.
10. Export and printable Opportunity Map.
11. Mobile, empty/error states, sample-data labels, final audit.
**Done when:** Dan can deliver an Opportunity Map from Talo without spreadsheets, and every item in §2 passes on production.

### Phase 4 — Commercial pilot (weeks 5–8)
Deliver paid work through Talo; improve from real use. Track time saved, acceptance rate, qualified conversations, conversion, delivery cost, satisfaction, repeat intent.
**Done when:** evidence that the workflow creates repeatable value.

### Phase 5 — Controlled automation (only after demand)
Candidates: metered AI research, permitted search APIs, monitoring, signal alerts, evidence freshness checks, Telegram notifications, optional Grok/X signal agent (public signal → verify → match → score → human review → pipeline). Each needs spending caps, per-workspace limits, audit records, human approval. Never automated unsolicited outreach.
**Done when:** automation saves work without making recommendations less trustworthy or costs uncontrolled.

### Phase 6 — Self-service SaaS (only when the economics justify it)
Multi-tenant auth, onboarding, payments, credits, roles, usage dashboard, in-app research, export and deletion, support. Managed service stays available.

---

## 9. Cost policy

Target: **$0 new infrastructure.** Allowed: local dev, free GitHub, Cloudflare free tier (Workers, D1, Access), existing Claude access, free Google tools, free Telegram bot features.
Deferred: VPS, Grok subscription, paid AI or search APIs, paid databases or CRMs, premium monitoring, messaging platforms, ads, domains before clearance, extra paid environments.

Before any paid service, write down: the problem it solves · why free isn't enough · monthly cost and usage assumptions · expected benefit · whether a paying customer covers it · how to switch it off. Dan approves in writing. No automatic plan upgrades.

---

## 10. Metrics

Main long-term metric: **qualified partnership opportunities advanced** — not lead volume.
First validation: one independently reviewed report · 8+ defensible matches from a broad pool · one real feedback session · one paid pilot.
After pilots: cost per research run · hours per brief · verification rate · acceptance rate · qualified conversations · response rate · partnerships advanced · repeat rate · revenue and margin.

---

## 11. Risks and open questions

### Risks
- **Name:** Talo isn't trademark-cleared; talo.com and talo.club are in commercial use. A rename later costs more than one now.
- **Demand:** the core bet (small teams pay for research-backed partnership opportunities) is unproven. Phases 1–2 exist to test it cheaply.
- **Research quality and time:** if a good Map takes too long by hand, service margins are poor. We measure this from Phase 1.
- **Source access:** X and some directories limit automated access, and some can't be reached from Claude's cloud session. Dan may need to supply screenshots or links.
- **Free-tier limits:** Cloudflare terms change. Checked before Phase 3, monitored after.
- **Trust:** one invented fact in a client brief damages credibility. The evidence standard and "Needs verification" rule are the safeguard.

### Needs Dan's decision or action
1. **Approve** this plan and `CLAUDE.md`.
2. **Repo visibility:** the blueprint says private. Is `danbuildss/talo` private? This affects what can go in git (pricing strategy, client names).
3. **Phase 1 test company:** which real company do we research first? (Somehow Business itself, a company you know, or a willing prospect.)
4. **Order of work:** the blueprint's day plan starts the app skeleton on days 6–7, before Client Zero. My recommendation: do Phase 3 PRs 1–3 (skeleton, database, access) early since they're cheap and don't depend on what we learn, then hold the feature PRs until Phase 2 feedback.
5. **Landing page:** a simple page with a pilot-request form could help Phase 2 recruitment, but a form stores personal data and implies a public brand before the name is cleared. Recommendation: no public page until the name check is done; use a Google Form or direct DMs for Phase 2.
6. **Cloudflare account:** Dan creates/owns it; Claude never gets the credentials. Needed by Phase 3.
7. **Legal entity** for contracts and invoices in Phase 2.
8. **Trademark jurisdictions** to check.
