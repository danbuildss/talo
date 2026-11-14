/**
 * Small helper for command-line scripts that call the Talo API.
 * Local: TALO_URL defaults to http://localhost:8787 (run `npm run dev` with .dev.vars).
 * Production: set TALO_URL to the Worker address and TALO_ADMIN_TOKEN to your admin key
 * (`npm run admin:key` makes one). If Cloudflare Access is used instead, set TALO_ACCESS_TOKEN
 * from `cloudflared access token -app=<TALO_URL>`. Never commit either.
 */
export const TALO_URL = (process.env.TALO_URL ?? "http://localhost:8787").replace(/\/$/, "");

export async function taloFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (process.env.TALO_ADMIN_TOKEN) headers.set("authorization", `Bearer ${process.env.TALO_ADMIN_TOKEN}`);
  if (process.env.TALO_ACCESS_TOKEN) headers.set("cf-access-token", process.env.TALO_ACCESS_TOKEN);
  if (init.body) headers.set("content-type", "application/json");
  try {
    return await fetch(`${TALO_URL}${path}`, { ...init, headers });
  } catch {
    console.error(`Could not reach ${TALO_URL}. Is the Worker running (npm run dev)?`);
    process.exit(2);
  }
}
