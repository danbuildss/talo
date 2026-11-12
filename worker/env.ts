/** Bindings and settings available to the Worker. */
export interface Env {
  DB: D1Database;
  /** "production" in wrangler.jsonc; "development" only in a local .dev.vars; "test" in tests. */
  ENVIRONMENT: string;
  /** Cloudflare Access team domain, e.g. "yourteam.cloudflareaccess.com". Set in the dashboard. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access application audience (AUD) tag. Set in the dashboard. */
  ACCESS_AUD?: string;
  /** Comma-separated admin emails allowed to use Talo. Set in the dashboard, never committed. */
  ADMIN_EMAILS?: string;
  /** Local development only: act as this admin without Access. Ignored unless ENVIRONMENT is "development" on localhost. */
  DEV_ADMIN_EMAIL?: string;
}

export interface Variables {
  /** The verified admin's email, set by the auth middleware. */
  adminEmail: string;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
