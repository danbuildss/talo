import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { createApp } from "../../worker/app.ts";
import type { Env } from "../../worker/env.ts";

export const TEAM = "talo-test.cloudflareaccess.com";
export const AUD = "test-audience";
export const ADMIN = "admin@talo.example";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "test", alg: "RS256" }] });

/** The app wired to a local test key set instead of Cloudflare's. */
export const app = createApp({ getKey: () => jwks });

export async function token(
  claims: JWTPayload = {},
  opts: { key?: CryptoKey; exp?: string; iss?: string; aud?: string } = {},
) {
  return new SignJWT({ email: ADMIN, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(opts.iss ?? `https://${TEAM}`)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? privateKey);
}

export async function call(
  path: string,
  init: RequestInit & { as?: string | null } = {},
  overrides: Partial<Env> = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.as !== null) headers.set("Cf-Access-Jwt-Assertion", init.as ?? (await token()));
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.fetch(new Request(`https://talo.example${path}`, { ...init, headers }), { ...env, ...overrides } as Env);
}
