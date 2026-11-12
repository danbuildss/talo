# Decisions

Short records of technical decisions, newest first. Product decisions live in `PLAN.md`.

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
