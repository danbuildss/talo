# Decisions

Short records of technical decisions, newest first. Product decisions live in `PLAN.md`.

## 2026-11-14: Pilot A, Grok signal search
- **Why Grok, not follow-graph tracking first:** partnership signals are posts ("partner program", "looking for integration partners", "now live on Base"), and xAI's `x_search` finds posts at about 5 USD per 1,000 posts plus tokens. Tracking who accounts follow costs about 0.01 USD per account returned, too expensive for full lists; a small follow-watch pilot (B) needs a 5 USD test first.
- **Grok can't invent results:** a post is kept only if its link is an X post URL **and** xAI cited it in the search results. Links that appear only in Grok's own answer are dropped.
- **Two spending stops:** the xAI console's monthly limit (hard), and Talo's own ledger, which estimates each search conservatively and skips Grok searches for the rest of the month at the cap (default 50 USD). No key means skipped, not failed.
- **Same rules as every source:** results go to the inbox; a person verifies the post before it becomes a signal. Requests ask xAI not to store them (`store: false`). Official API only, no resellers.
- `watched_sources` was rebuilt to allow the new adapter (SQLite can't change a CHECK in place); data is copied unchanged.

## 2026-11-14: Collector (Talo Data, step 4)
- **The collector fills an inbox, never the feed.** New items from watched sources land in `collected_items`; a person turns one into a signal (writing the factual claim) or dismisses it. The collector never creates or verifies signals, and no AI runs in the Worker.
- **Four readers:** RSS/Atom, GitHub releases (REST API, optional free token), page change detection (stores only a fingerprint; the first visit is a baseline), and registry listings (the MCP Registry, and key maps like the elizaOS plugin index, where only new keys count; the first visit is a baseline).
- **Polite and inside free limits:** an hourly Cron checks at most 5 due sources; conditional requests (ETag / Last-Modified); 10-second timeout; 25 items per run; a clear User-Agent pointing to this repo.
- **Failures are visible, not fatal:** every run is logged; failures back off (interval doubled per failure, max 7 days) and a source pauses after 5 failures in a row. One broken source never stops the others; an unreadable response is logged as a failed run rather than stored.
- **Every watched source records why Talo may read it** (`terms_note`); sources whose address or access isn't confirmed start paused.
- **Suggested signal types are keyword hints only**; funding is never suggested.

## 2026-11-14: Admin curation API (Talo Data, step 3)
- **Imports are all-or-nothing and checked first.** A `talo.registry.v1` file is checked in full (clashes with the database and within the file, signals for unknown companies, unknown categories, repeated events) before anything is written; any problem rejects the whole file with row-by-row reasons. `?dry_run=1` checks only.
- **Editing verified facts reopens review.** Changing a verified company's name or description, or any field of a verified signal, sends it back to needs_review with a logged reason. Categories are Talo's own labels and don't reopen.
- **Command-line scripts call the API** (`registry:import`, `data:audit`), locally by default; in production they use the admin's own short-lived Cloudflare Access token.

## 2026-11-14: Signals and verification (Talo Data, step 2)
- **"Stale" is calculated, not stored.** A verified signal is shown as stale when its last check is older than its type's freshness window, so it can never be out of date. Stored statuses are needs_review, verified and rejected.
- **Verifying needs proof of where you looked.** A signal is verified only against one of its own sources; a company only against a page on its own domain. Rejecting needs a reason.
- **Every status change writes a review in the same database batch.** The review log is append-only (database triggers refuse edits and deletes), and the database refuses a verified record without a verification date or a rejected one without a reason.
- **Public = verified signal of a verified company.** A verified signal on an unverified company stays hidden and is listed in the audit.
- **Funding is not a signal type**, by design: it doesn't show partnership intent.
- **The audit is a function now** (`worker/db/audit.ts`); it becomes `npm run data:audit` / an admin endpoint with the curation API.

## 2026-11-14: Company registry (Talo Data, step 1)
- **Duplicates are stopped by aliases.** Every company has normalized aliases (name, domain, GitHub org, X handle) with `UNIQUE(kind, value)`. A new company that shares any alias is refused, naming the existing company. Names ignore case, punctuation and legal suffixes (Inc, Ltd…) but keep meaningful words (Labs, AI).
- **Near-duplicates are flagged, not blocked:** the same domain name on different endings (acme.ai / acme.com) or names one letter apart go to a person to decide; `mergeCompanies` combines them.
- **One URL, one source:** URLs are normalized (no www, fragment, tracking parameters or trailing slash; sorted query) before storing.
- **Shared tables are listed explicitly** in the isolation test, so every new table has to be classed as shared or private on purpose.
- New companies always start as `needs_review`; verification arrives with signals in the next step.

## 2026-11-12: Back-end foundation (Phase 3a)
- **One Cloudflare Worker** with Hono for routing and Zod for validation; D1 for data. Free tier.
- **Login = Cloudflare Access + a server-side check.** The Worker verifies the Access token (signature, issuer, audience, expiry) and an email allowlist on every `/api` request, and fails closed if not configured. A local-only shortcut exists for development (localhost + `ENVIRONMENT=development`).
- **Workspace isolation:** every table except `workspaces` has `workspace_id`; every query filters by it; a test checks the schema and that one workspace can't read another's data. Deleting a workspace deletes all its data (foreign keys with cascade).
- **Evaluations are stored, not just computed:** each scoring is saved with the calculated score, confidence and status, so history is kept when scores change.
- **Tests run in the real Workers runtime** with `@cloudflare/vitest-plugin` (the renamed `vitest-pool-workers`), against a real local D1.
- **Compatibility date 2026-08-22:** the newest date the local Workers runtime supports; production accepts it. Bump when tooling catches up.
- **`.npmrc` sets `legacy-peer-deps`:** npm 10 crashed resolving an optional Vitest peer; this keeps `npm install` working.

## 2026-11-12: Research formats (Phase 1)
- Three JSON formats (`talo.company.v1`, `talo.candidates.v1`, `talo.outreach.v1`) defined once in Zod, with generated JSON Schemas.
- Overall scores are calculated by code, never accepted from research files.
