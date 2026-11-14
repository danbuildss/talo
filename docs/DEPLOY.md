# Deploying Talo (Cloudflare free tier)

Dan does these steps in the Cloudflare dashboard. Claude never needs the account login or any key. Nothing here should cost money; check Cloudflare's current free-tier limits before starting and stop if anything asks for payment.

## Once: set up

1. **Cloudflare account.** Create one (free) if you don't have it.
2. **Create the database.** Dashboard → Storage & Databases → D1 → Create → name it `talo`. Copy its **Database ID**.
   Send Claude the ID (it isn't secret); it goes in `wrangler.jsonc` in a small PR.
3. **Connect GitHub (optional, recommended).** Workers & Pages → Create → Import a repository → `danbuildss/talo`, branch `main`. Cloudflare then deploys on every merge. The build command is `npm run deploy`. Otherwise run `npm run deploy` yourself from a computer.
4. **Turn on Cloudflare Access (the login).** Zero Trust → Access → Applications → Add an application → Self-hosted:
   - Domain: the Worker's address (e.g. `talo.<your-subdomain>.workers.dev`).
   - Policy: **Allow**, rule **Emails**, your email address.
   - Save, then copy the **Application Audience (AUD) tag**.
   - Your **team domain** is shown under Zero Trust → Settings (looks like `yourteam.cloudflareaccess.com`).
5. **Set the Worker's settings.** Workers & Pages → talo → Settings → Variables and Secrets. Add:
   - `ACCESS_TEAM_DOMAIN` = your team domain (e.g. `yourteam.cloudflareaccess.com`)
   - `ACCESS_AUD` = the AUD tag
   - `ADMIN_EMAILS` = your email (comma-separate if more than one)
   Use type "Secret" for `ACCESS_AUD` and `ADMIN_EMAILS`.
6. **Create the tables.** From a computer with the repo: `npx wrangler d1 migrations apply talo --remote`.

## Check it works

- `https://talo.<your-subdomain>.workers.dev/api/health` → `{"ok":true}` (public, no data).
- `/api/me` in a browser → Cloudflare Access login → `{"email":"you@…"}`.
- Without logging in, `/api/me` must not return data.

If sign-in isn't configured yet, the API answers "Sign-in is not configured yet" (503) and returns no data. It fails closed.

## The collector

- The hourly schedule is in `wrangler.jsonc` and starts when the Worker is deployed.
- Load the approved sources once: `npm run sources:seed` (with `TALO_URL` and `TALO_ACCESS_TOKEN` set as below). Sources marked "to confirm" start paused.
- Optional: a free GitHub token (no special permissions needed for public repositories) raises GitHub's limit from 60 to 5,000 requests an hour. Add it as a Secret named `GITHUB_TOKEN` in the Worker's settings. Never paste it in chat or commit it.
- Check health at `/api/admin/watched-sources` and `/api/admin/runs`; new finds wait at `/api/admin/inbox`.

## Pilot A: Grok signal search (optional, paid, capped)

Approved by Dan on 2026-11-14 with a **50 USD monthly cap**. Without a key, the Grok searches are skipped and nothing is spent.

1. Go to **console.x.ai** (xAI's developer console). A Grok app or X Premium subscription is **not** the same thing: the API needs its own credits.
2. Add a small amount of credit, and **set a monthly spending limit there** (the hard stop). Suggested: 50 USD.
3. Create an API key. In Cloudflare: Workers & Pages → talo → Settings → Variables and Secrets → add a **Secret** named `XAI_API_KEY`. Never paste it in chat or commit it.
4. Optional settings (plain variables): `GROK_MONTHLY_CAP_USD` (default 50), `GROK_MODEL` (default `grok-4.3`).
5. `npm run sources:seed` adds the 7 Grok searches with the other sources.

Talo also stops itself: it estimates each search's cost, records it, and skips Grok searches for the rest of the month once the cap is reached. Check `/api/admin/spend`. Results go to the inbox only; every post is checked by a person before it becomes a signal.

## Curating data in production

Reviews happen through the admin API (screens come later). From a computer with the repo:

1. Install Cloudflare's `cloudflared` tool and log in once: `cloudflared access login https://talo.<your-subdomain>.workers.dev`
2. Get a short-lived token from your own login: `export TALO_ACCESS_TOKEN=$(cloudflared access token -app=https://talo.<your-subdomain>.workers.dev)`
3. Point the scripts at production: `export TALO_URL=https://talo.<your-subdomain>.workers.dev`
4. `npm run registry:import -- file.json --dry-run`, then without `--dry-run`; `npm run data:audit`.

The token is yours and expires; never paste it into chat or commit it. The audit is also readable in a browser at `/api/admin/audit` after logging in.

## Backups

- `npx wrangler d1 export talo --remote --output backup-YYYY-MM-DD.sql` (keep the file private; never commit it).
