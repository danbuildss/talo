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

export function requireAdmin(options: AuthOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const env = c.env;
    const allowlist = parseAllowlist(env.ADMIN_EMAILS);

    // Local development shortcut: only on localhost, only when explicitly enabled.
    if (env.ENVIRONMENT === "development" && env.DEV_ADMIN_EMAIL && isLocalhost(c.req.url)) {
      c.set("adminEmail", env.DEV_ADMIN_EMAIL.toLowerCase());
      return next();
    }

    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || allowlist.size === 0) {
      console.error("auth: access is not configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD, ADMIN_EMAILS)");
      return jsonError(c, 503, "not_configured", "Sign-in is not configured yet.");
    }

    const token = c.req.header(ACCESS_HEADER);
    if (!token) return jsonError(c, 401, "unauthenticated", "Sign in through Cloudflare Access.");

    let email: string | undefined;
    try {
      const getKey = options.getKey?.(env) ?? remoteKeys(env.ACCESS_TEAM_DOMAIN);
      const { payload } = await jwtVerify(token, getKey, {
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
  };
}
