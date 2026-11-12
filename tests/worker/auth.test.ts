import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { parseAllowlist } from "../../worker/middleware/auth.ts";
import { call, token } from "./helpers.ts";

describe("health", () => {
  it("is public and returns no data", async () => {
    const res = await call("/api/health", { as: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("sets security headers", async () => {
    const res = await call("/api/health", { as: null });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("admin access", () => {
  it("lets a valid admin in", async () => {
    const res = await call("/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "admin@talo.example" });
  });

  it("matches the allowlist case-insensitively", async () => {
    const res = await call("/api/me", { as: await token({ email: "SECOND@talo.EXAMPLE" }) });
    expect(res.status).toBe(200);
  });

  it("rejects a request with no token", async () => {
    const res = await call("/api/me", { as: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("rejects a garbage token", async () => {
    expect((await call("/api/me", { as: "not-a-jwt" })).status).toBe(401);
  });

  it("rejects a token signed by another key", async () => {
    const other = await generateKeyPair("RS256");
    expect((await call("/api/me", { as: await token({}, { key: other.privateKey }) })).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    expect((await call("/api/me", { as: await token({}, { exp: "-1m" }) })).status).toBe(401);
  });

  it("rejects the wrong audience", async () => {
    expect((await call("/api/me", { as: await token({}, { aud: "someone-else" }) })).status).toBe(401);
  });

  it("rejects the wrong issuer", async () => {
    expect((await call("/api/me", { as: await token({}, { iss: "https://evil.cloudflareaccess.com" }) })).status).toBe(
      401,
    );
  });

  it("rejects a valid token for someone not on the allowlist", async () => {
    const res = await call("/api/me", { as: await token({ email: "stranger@example.com" }) });
    expect(res.status).toBe(403);
  });

  it("rejects a valid token without an email", async () => {
    expect((await call("/api/me", { as: await token({ email: undefined }) })).status).toBe(403);
  });

  it("fails closed when sign-in isn't configured", async () => {
    const res = await call("/api/me", {}, { ACCESS_AUD: "" });
    expect(res.status).toBe(503);
    const empty = await call("/api/me", {}, { ADMIN_EMAILS: "" });
    expect(empty.status).toBe(503);
  });

  it("protects every API route, including unknown ones", async () => {
    for (const path of ["/api/workspaces", "/api/workspaces/x", "/api/anything"]) {
      expect((await call(path, { as: null })).status).toBe(401);
    }
  });

  it("only allows the development shortcut on localhost in development", async () => {
    const dev = { ENVIRONMENT: "development", DEV_ADMIN_EMAIL: "dev@talo.example" };
    // Not localhost: shortcut ignored, normal checks apply.
    expect((await call("/api/me", { as: null }, dev)).status).toBe(401);
    // Production with the variable set by mistake: still ignored.
    expect((await call("/api/me", { as: null }, { DEV_ADMIN_EMAIL: "dev@talo.example" })).status).toBe(401);
  });
});

describe("parseAllowlist", () => {
  it("trims, lowercases and drops junk", () => {
    expect([...parseAllowlist(" A@x.com, ,b@Y.com,nope ")]).toEqual(["a@x.com", "b@y.com"]);
    expect(parseAllowlist(undefined).size).toBe(0);
  });
});
