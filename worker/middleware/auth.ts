/**
 * Admin-only access. Cloudflare Access sits in front of the app; this middleware
 * checks the Access token again on every API request, so a misconfigured
 * dashboard rule can't expose data. It fails closed.
 *
 * Checks: a valid Cf-Access-Jwt-Assertion (signature from the team's keys,
 * issuer, audience, expiry) AND an email on the ADMIN_EMAILS allowlist.
 */
import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { AppEnv, Env } from "../env.ts";
import { jsonError } from "../http.ts";

export const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

/** Key sets are cached per team domain for the life of the isolate. */
const keySets = new Map<string, JWTVerifyGetKey>();
function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keys);
  }
  return keys;
}

export function parseAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@")),
  );
}

function isLocalhost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export interface AuthOptions {
  /** Override how signing keys are found (tests). Defaults to the team's public keys. */
  getKey?: (env: Env) => JWTVerifyGetKey;
}

/** An admin key must be at least this long, or it's treated as not configured. */
export const MIN_ADMIN_TOKEN_LENGTH = 32;

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

/** Compares two secrets without leaking how much of them matched. */
export async function secretsMatch(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function accessConfigured(
  env: Env,
  allowlist: Set<string>,
): env is Env & { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string } {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && allowlist.size > 0);
}

/**
 * Admin-only access, two ways (either can be configured; both fail closed):
 * 1. Admin key (Option B, chosen by Dan 2026-11-14): `Authorization: Bearer <ADMIN_TOKEN>`.
 *    ADMIN_TOKEN is a Cloudflare secret of at least 32 characters.
 * 2. Cloudflare Access (Zero Trust), if configured later: the Access token is verified here too.
 */
export function requireAdmin(options: AuthOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const env = c.env;
    const allowlist = parseAllowlist(env.ADMIN_EMAILS);

    // Local development shortcut: only on localhost, only when explicitly enabled.
    if (env.ENVIRONMENT === "development" && env.DEV_ADMIN_EMAIL && isLocalhost(c.req.url)) {
      c.set("adminEmail", env.DEV_ADMIN_EMAIL.toLowerCase());
      return next();
    }

    const tokenConfigured = (env.ADMIN_TOKEN ?? "").length >= MIN_ADMIN_TOKEN_LENGTH;
    if (env.ADMIN_TOKEN && !tokenConfigured) {
      console.error(`auth: ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN_LENGTH} characters and is ignored`);
    }
    const access = accessConfigured(env, allowlist);
    if (!tokenConfigured && !access) {
      console.error("auth: no sign-in method is configured (ADMIN_TOKEN, or Cloudflare Access)");
      return jsonError(c, 503, "not_configured", "Sign-in is not configured yet.");
    }

    // 1. Admin key
    const bearer = c.req
      .header("authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim();
    if (bearer && tokenConfigured) {
      if (await secretsMatch(bearer, env.ADMIN_TOKEN as string)) {
        c.set("adminEmail", (env.ADMIN_NAME || "admin").toLowerCase());
        return next();
      }
      return jsonError(c, 401, "unauthenticated", "That admin key isn't valid.");
    }

    // 2. Cloudflare Access
    const jwt = c.req.header(ACCESS_HEADER);
    if (jwt && access) {
      let email: string | undefined;
      try {
        const getKey = options.getKey?.(env) ?? remoteKeys(env.ACCESS_TEAM_DOMAIN);
        const { payload } = await jwtVerify(jwt, getKey, {
          issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
          audience: env.ACCESS_AUD,
          algorithms: ["RS256"],
        });
        email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
      } catch {
        return jsonError(c, 401, "unauthenticated", "Your sign-in is invalid or expired.");
      }
      if (!email || !allowlist.has(email)) {
        return jsonError(c, 403, "forbidden", "This account is not allowed to use Talo.");
      }
      c.set("adminEmail", email);
      return next();
    }

    return jsonError(
      c,
      401,
      "unauthenticated",
      tokenConfigured ? "Send your admin key as: Authorization: Bearer <key>." : "Sign in through Cloudflare Access.",
    );
  };
}
