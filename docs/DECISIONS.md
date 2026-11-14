# Decisions

Short records of technical decisions, newest first. Product decisions live in `PLAN.md`.

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
