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

## Backups

- `npx wrangler d1 export talo --remote --output backup-YYYY-MM-DD.sql` (keep the file private; never commit it).
