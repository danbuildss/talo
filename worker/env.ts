/** Bindings and settings available to the Worker. */
export interface Env {
  DB: D1Database;
  /** "production" in wrangler.jsonc; "development" only in a local .dev.vars; "test" in tests. */
  ENVIRONMENT: string;
  /** Admin key (Option B): a Cloudflare secret, 32+ random characters. Make one with `npm run admin:key`. */
  ADMIN_TOKEN?: string;
  /** Name recorded as the reviewer when the admin key is used (e.g. "dan"). Default "admin". */
  ADMIN_NAME?: string;
  /** Cloudflare Access team domain, e.g. "yourteam.cloudflareaccess.com". Set in the dashboard. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience (AUD) tag. Set in the dashboard. */
  ACCESS_AUD?: string;
  /** Comma-separated admin emails allowed to use Talo. Set in the dashboard, never committed. */
  ADMIN_EMAILS?: string;
  /** Optional free GitHub token (a Cloudflare secret) raising the API limit from 60 to 5,000 requests an hour. */
  GITHUB_TOKEN?: string;
  /** Pilot A (Grok signal search): xAI API key, a Cloudflare secret. Without it Grok sources are skipped. */
  XAI_API_KEY?: string;
  /** Optional overrides: model name, monthly cap in USD (default 50), and prices used for Talo's estimate. */
  GROK_MODEL?: string;
  GROK_MONTHLY_CAP_USD?: string;
  GROK_PRICE_PER_POST_USD?: string;
  GROK_PRICE_INPUT_PER_M_USD?: string;
  GROK_PRICE_OUTPUT_PER_M_USD?: string;
  /** Local development only: act as this admin without Access. Ignored unless ENVIRONMENT is "development" on localhost. */
  DEV_ADMIN_EMAIL?: string;
}

export interface Variables {
  /** The verified admin's email, set by the auth middleware. */
  adminEmail: string;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
