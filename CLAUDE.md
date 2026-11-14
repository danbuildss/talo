# Talo — how we work

Talo (shown as **talo.**) is a partnership discovery and intelligence platform: a curated, source-backed database of companies and partnership signals, on which it helps early-stage AI, Web3 and developer-infrastructure companies find the right partners, understand what each side gains, prepare a credible approach and track the relationship. Main rule: no source, no verified claim. Built by Somehow Internet. Owner: Dan. The repo is public.

## Read first, every session
1. This file: how we work.
2. `PLAN.md`: what we're building. It wins over everything else.
3. `brand/BRAND.md`: how it looks and sounds (once it exists).
4. `talo-notes.md` (private, not in git): where we are, what's next.
If the notes file is missing, ask before assuming anything.

## The loop
- Sketch first, then wait for approval, then build. Never build before "approve".
- Back end first: the API and data are built and tested before screens, and screens before polish.
- One PR per change, with a plain description. Dan merges.
- Before every PR: tests, lint, typecheck, production build. UI checked at phone and desktop width.
- After a merge: check production and report what works.
- Update `talo-notes.md` after every step.

## Rules
- Only claim what is live and checkable. Never invent numbers, users, cases, partners, contacts or quotes.
- Research output separates **verified facts** (with a source link and date) from **inferences**. Anything not backed by a source says "Needs verification".
- Fit scores come from the fixed formula in `PLAN.md`. The model gives a 0–5 score for each factor with a reason; it never makes up the overall number.
- No scraping that a site's terms don't allow. Public sources, permitted APIs, or links Dan supplies.
- Talo never sends messages. It drafts; a person reviews, approves and sends.
- Never imply a partner endorses us. "Talo" is a working name until trademark and domain checks are done, so no claims that a domain or handle is ours or is available.
- No spending. No paid services, upgrades, domains or subscriptions without Dan's explicit approval and the budget note in `PLAN.md` §9.
- Don't show a button or page as working unless the backend behind it works. Unfinished features are hidden or labelled.
- Client data stays in its workspace. Never send confidential client information to an outside AI service without permission.
- Test and demo data is clearly labelled as such.
- The repo is public. Client names, client research, Opportunity Maps, drafts, pricing and launch material stay out of git (`.git/info/exclude`). Sample data is fictional and labelled.
- No secrets in chat, code, commits or logs. Keys go in the Cloudflare dashboard or `.dev.vars` (git-ignored).
- No model names in commits or PRs.
- Dan posts everything and does all outreach. Claude drafts.
- Talk to Dan in plain language: what changed, what Dan needs to do.

## Dev
Node 22+.
- Install: `npm install`
- Everything before a PR: `npm run check` (lint, typecheck, tests, production build)
- Tests only: `npm test` (unit tests in Node; API tests in the real Workers runtime with a local D1)
- Fix formatting: `npm run format`
- Run locally: `cp .dev.vars.example .dev.vars`, `npm run db:migrate:local`, then `npm run dev` (http://localhost:8787)
- Regenerate research JSON Schemas after changing `shared/`: `npm run schema`
- Check a research file: `npm run check:research -- file.json`
- Add companies and signals (as needs_review): `npm run registry:import -- file.json [--dry-run]` (format: `schemas/registry-file.schema.json`, example: `samples/registry.sample.json`)
- Data quality report: `npm run data:audit` (local by default; production: see `docs/DEPLOY.md`)
- Load the approved watched sources: `npm run sources:seed` (list: `seeds/watched-sources.json`). Test the hourly collector locally with `npx wrangler dev --test-scheduled` and `curl "localhost:8787/__scheduled"`
- Deploy: see `docs/DEPLOY.md` (Dan's Cloudflare account); production URL: TBD
- Technical decisions: `docs/DECISIONS.md`
