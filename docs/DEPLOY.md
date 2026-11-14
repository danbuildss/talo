# Deploying Rightroom (Cloudflare free tier)

Dan does these steps in the Cloudflare dashboard. Claude never needs the account login or any key. Nothing here should cost money; check Cloudflare's current free-tier limits before starting and stop if anything asks for payment.

## Once: set up

1. **Cloudflare account.** Create one (free). No card is needed for Workers or D1.
2. **Database.** Storage & Databases → D1 → Create. Send Claude the **Database ID** (it isn't secret); it goes in `wrangler.jsonc`. ✅ Done (2026-11-14).
3. **Connect GitHub.** Workers & Pages → Create → Import a repository → `danbuildss/rightroom`. The Worker must be named `rightroom` (the name in `wrangler.jsonc`).
   - Build command: `npm run build` (or leave empty)
   - Deploy command: `npm run deploy` (creates or updates the database tables, then deploys)
4. **Admin key (the login, Option B, no card needed).** On a computer with the repo: `npm run admin:key`. It prints a long random key once.
   - Cloudflare: Workers & Pages → rightroom → Settings → Variables and Secrets → **Add → Secret**, name `ADMIN_TOKEN`, value = the key.
   - The type must be **Secret** (shown as hidden dots). If Cloudflare shows the value or suggests adding it to `wrangler.jsonc`, it was saved as Text: delete it, make a new key and add it again as Secret. Never put a secret in `wrangler.jsonc` (the repo is public).
   - `ADMIN_NAME` (recorded on reviews) is set in `wrangler.jsonc`, because plain settings added only in the dashboard are reset on each deploy.
   - Keep the key in a password manager. Never paste it in chat or commit it, and don't screenshot its value. If it leaks, make a new one and replace the secret.
5. **Tables.** If the deploy command above didn't create them: `npx wrangler d1 migrations apply DB --remote` from a computer with the repo.

Cloudflare Access (Zero Trust) can replace or sit alongside the admin key later; it asks for a card on file even on its free plan. The Worker supports both.

## Check it works

- `https://rightroom.<your-subdomain>.workers.dev/api/health` → `{"ok":true}` (public, no data).
- `curl -H "Authorization: Bearer $TALO_ADMIN_TOKEN" https://rightroom.<your-subdomain>.workers.dev/api/me` → `{"email":"dan"}`.
- Without the key, `/api/me` must answer 401 and return no data.

If no sign-in is configured, the API answers "Sign-in is not configured yet" (503) and returns no data. It fails closed.

## The collector

- The hourly schedule is in `wrangler.jsonc` and starts when the Worker is deployed.
- Load the approved sources once: `npm run sources:seed` (with `TALO_URL` and `TALO_ADMIN_TOKEN` set as below). Sources marked "to confirm" start paused.
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

1. `export TALO_URL=https://rightroom.<your-subdomain>.workers.dev`
2. `export TALO_ADMIN_TOKEN=<your admin key>` (from your password manager)
3. `npm run registry:import -- file.json --dry-run`, then without `--dry-run`; `npm run data:audit`; `npm run sources:seed`.
4. **Review the queue:** `npm run review`. It shows one company or signal at a time and opens its source in your browser. Press **a** to approve (you'll say which page you checked; for signals, paste the page's exact sentence), **r** to reject with a reason, **s** to skip, **q** to stop. The server still enforces every rule.

Never paste the key into chat or commit it.

## Backups

- `npx wrangler d1 export DB --remote --output backup-YYYY-MM-DD.sql` (keep the file private; never commit it).
