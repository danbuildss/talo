# Talo Data Engine and Discover: design (draft for approval)

Status: **draft**, from Dan's Product Direction Update v1.1 (November 2026). Nothing here is built until Dan approves. When approved, the product parts move into `PLAN.md`.

**The main rule: no source, no verified claim.**

---

## 1. What changes, what stays

| Stays | Changes |
|---|---|
| Owner (Somehow Internet), $0 budget, AI/Web3/dev-infra market | The product is a **discovery and intelligence platform**, not only a report generator |
| Research method, fit formula, evidence confidence | A **shared company and signal database** is the foundation |
| Admin login, workspaces, isolation (PR #5) | Workspace candidates point at shared company records, so companies are never duplicated across workspaces |
| Managed service (Opportunity Map, Sprint) as first revenue | A **public, read-only Discover** feed of verified records |
| Talo never sends messages | Matching, outreach and watchlists come after Data and Discover |

New architecture: **company database → signals → Discover feed → partner matching → outreach → relationship tracking.**
AI helps with extraction, classification and partnership theses. Collection, deduplication, source tracking and freshness are deterministic code.

## 2. Three data layers

| Layer | What | Shared or private |
|---|---|---|
| 1. Company intelligence | Who companies are, what they build, sectors, technologies, official URLs | Shared |
| 2. Partnership signals | What changed recently that could create an opportunity | Shared |
| 3. Partnership intelligence | Why company X fits customer Y: fit score, mutual value, risks, next step | **Private to a workspace** |

A company has no universal fit score. Fit is always calculated for one customer's goals.

## 3. Database additions (migration 0002)

Shared tables (no `workspace_id`; written only by admins, readable publicly only when published):

| Table | Purpose | Key rules |
|---|---|---|
| `companies` | One row per real company | `status`: needs_review / verified / rejected; `last_verified_at` |
| `company_aliases` | Names, domains, GitHub orgs, X handles, normalized | `UNIQUE(kind, value)`, which is how duplicates are caught |
| `categories`, `company_categories` | Sector, technology, ecosystem tags (e.g. `ai-agents`, `wallets`, `payments`, `dev-platforms`, `base`) | Fixed list, edited by admins |
| `sources` | Every evidence document: URL, kind, title, published date, first seen, last fetched, content hash, stored excerpt | `UNIQUE(normalized_url)` |
| `watched_sources` | The **source registry**: feeds, repos and pages Talo checks on a schedule | adapter, interval, terms-checked note, enabled, next run, last success, last error, failure count |
| `signal_types` | The signal categories below | Each type says whether it shows **explicit** partnership intent |
| `signal_events` | One partnership-relevant event | See below |
| `signal_sources` | Links signals to sources (primary / corroborating) | Every published signal has exactly one primary source |
| `company_relationships` | integrates_with, built_on, partner_of, competitor_of | Each needs a source |
| `verification_reviews` | Audit log of every status change: who, when, which URL was checked, why | Append-only |
| `ingestion_runs` | One row per collection run: source, items seen, items new, errors | For the admin health view |

Private tables (with `workspace_id`):

| Table | Purpose |
|---|---|
| `partner_candidates` (exists) | Gains `company_id`, so a workspace's candidate is a private **match** against a shared company. Plays the role of "partner_matches". |
| `watchlists` | Companies a workspace follows |

### A signal record

| Field | Meaning |
|---|---|
| `company_id`, `signal_type` | Who and what kind |
| `title` | Short, factual: "Launched a developer partner program" |
| `factual_claim` | The exact claim the primary source supports, in plain words |
| `source_excerpt` | The sentence(s) from the source that support it |
| `opportunity_note` | Why it might matter for partnerships. **Always labelled as inference.** |
| `event_date` | When it happened (from the source), if known |
| `discovered_at` | When Talo first saw it |
| `last_verified_at` | When a person last confirmed it |
| `status` | needs_review → verified → stale, or rejected |
| `dedupe_key` | company + type + normalized primary URL, so the same event is never stored twice |

### Signal types (first set)

| Type | Intent | Freshness window |
|---|---|---|
| `partner_program_launched` | Explicit | 30 days, recheck before outreach |
| `collaboration_request` | Explicit | 14 days |
| `partnerships_role_posted` | Weak, implied | 30 days |
| `integration_announced` | Implied | 90 days |
| `api_or_sdk_released` | Implied | 90 days |
| `product_launched` | Implied | 90 days |
| `ecosystem_expansion` | Implied | 90 days |

Funding news is **not** a signal type. It can be recorded as a fact on the company, but it never implies partnership intent.

## 4. Verification rubric

| Status | Rule |
|---|---|
| **needs_review** | Default for everything new: collected, imported or drafted by Claude |
| **verified** | A person opened the primary source and confirmed it states the `factual_claim`, and a `verification_reviews` row records who, when and the URL. A convincing explanation never verifies anything. |
| **stale** | Verified, but `last_verified_at` is older than the type's freshness window. Still shown publicly, with "Last verified [date]". |
| **rejected** | Wrong, duplicate, unsupported or no longer applies. Kept with its reason, never shown publicly. |

- Companies follow the same statuses. A company is verified when its official domain and description are confirmed.
- **Public Discover shows only verified and stale records**, always with source links, event date and last-verified date.
- Inferred opportunities are always labelled "Why Talo flagged it (our view)", never as fact.

## 5. Collection pipeline

```
watched_sources ──(Cron, small batches)──> adapters ──> sources (deduped by URL, hashed)
                                                        │
                       rules-based classifier (keywords) ▼
                                         signal_events (needs_review)
                                                        │
                                  admin review queue ◀──┘──> verified / rejected
                                                        │
                                       public Discover ◀┘ (verified + stale only)
```

**Adapters** (same interface: given a watched source, return new items with URL, title, date, excerpt and content hash):

| Adapter | First version |
|---|---|
| `rss` | Official blog and announcement feeds (RSS/Atom) |
| `github_releases` | Releases of tracked repos via the GitHub REST API, using conditional requests (ETag) so unchanged repos don't count against limits. An optional free GitHub token, stored as a Cloudflare secret, raises the limit from 60 to 5,000 requests/hour. |
| `page_watch` | Detects that a partner-program or integrations page changed (content hash) and queues it for review. No extraction. |
| `manual_import` | A JSON file (`talo.registry.v1`) of companies, sources and draft signals, prepared with Claude's research skills and imported as needs_review |

**Rules:**
- Only sources whose terms allow access are added to `watched_sources`. The check is recorded on the row.
- Each Cron run takes the few sources that are due, so it stays inside free-tier per-run limits on CPU and outgoing requests.
- After repeated failures a source is paused and shown in the admin view.
- No X scraping. X posts enter only as manually reviewed links.
- No Product Hunt API, because commercial use needs their permission.
- No AI runs inside the Worker in this phase. Claude-assisted extraction happens in a session and comes in through `manual_import`.

**Who verifies:**
- My session can't open websites directly (only search summaries), so I can draft records but can't verify them.
- The deployed collector **can** fetch pages. It stores the excerpt, and you approve it in the review queue with the link one click away.

## 6. Public Discover (read-only)

A public API (`/api/public/...`, no login, read-only, published records only, rate-limited):
- `GET /companies` with search and sector filters
- `GET /companies/:slug` returning the profile, signals, sources and last-verified dates
- `GET /signals` returning the feed, newest first, filterable by type and sector

Screens come after the API works, as agreed (back end first):
- **Landing:** "Find companies worth building with." It has a search box and the latest *real* signals. No placeholder companies are shown as real.
- **Signal feed:** each card shows what happened, why Talo flagged it (labelled as our view), the source link and the dates.
- **Company page:** profile, signals over time, relationships and sources.

Design: the talo. brand guide (black and white, Geist), with blue as the one accent. Frontrun's interface, colours and mascot are not copied.

## 7. Data quality checks

Automated tests, plus an `npm run data:audit` report against the live database:

| Check | Standard |
|---|---|
| Published signals with a primary source | 100% |
| Published signals with a verification review | 100% |
| Inferences shown as facts | 0 (the opportunity note is always labelled) |
| Two companies sharing an alias | 0 (blocked by the database; audit lists near-matches) |
| Published records past freshness shown as current | 0 (they become stale automatically) |
| Collection failures | Logged per run, visible in admin |

## 8. Free-tier fit

Cloudflare's free limits (check the current terms before deploying):
- Workers: 100,000 requests a day, with a short CPU allowance and a cap on outgoing requests per run.
- D1: 5 million rows read and 100,000 written a day, and 5 GB of storage.
- Cron Triggers are included.

A curated dataset of hundreds of companies and a few dozen feeds checked daily fits comfortably. If a limit is hit, the free plan fails requests rather than charging, and the collector backs off.

## 9. Build order (one PR each, after approval)

1. **Plan update:** `PLAN.md` v1.1 plus this design.
2. **Company registry:** migration 0002 for companies, aliases, categories and sources; duplicate detection; tests.
3. **Signals and verification:** signal types, signal events, reviews, freshness and staleness, audit report; tests.
4. **Admin curation API:** import `talo.registry.v1`, the review queue (approve, reject, correct), and editing.
5. **Public Discover API:** read-only, published records only, rate-limited.
6. **Collector:** source registry, Cron, the RSS and GitHub adapters, page watch, ingestion runs.
7. **Discover screens:** landing, feed, company page. Mock-up first.

**In parallel (data work):**
- I draft the first 50 companies and about 20 signals with the research skills, as needs_review.
- They go live only after you verify them in the admin queue. Expect a few hours of review.

**Paused:** the workspace features planned as Phase 3a part B (candidate import, drafts, pipeline). They come back as Talo Match, Outreach and Watch on top of the shared company records.
