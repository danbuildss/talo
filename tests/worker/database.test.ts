import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type CandidateInput, candidateSchema } from "../../shared/candidate.ts";
import { getCandidate, insertCandidate, listCandidates } from "../../worker/db/candidates.ts";
import { ConflictError } from "../../worker/db/util.ts";
import { createWorkspace } from "../../worker/db/workspaces.ts";
import { call } from "./helpers.ts";

const NOW = new Date("2026-11-12T12:00:00Z");

function candidate(overrides: Partial<CandidateInput> = {}) {
  return candidateSchema.parse({
    company_name: "Northwind Agents (fictional)",
    domain: "northwind.example",
    industry: "Agent SDK",
    partnership_type: "integration",
    sources: [
      {
        url: "https://northwind.example/integrations",
        title: "Integrations",
        accessed_at: "2026-11-10",
        summary: "Lists partners.",
        claim_type: "verified",
        supports: ["alignment", "readiness"],
      },
    ],
    research_timestamp: "2026-11-10T14:00:00Z",
    evidence_summary: "Public integrations page.",
    scores: {
      alignment: { score: 4, reason: "r" },
      mutual_value: { score: 4, reason: "r" },
      readiness: { score: 3, reason: "r" },
      contact_access: { score: 3, reason: "r" },
      feasibility: { score: 4, reason: "r" },
    },
    mutual_benefits: { for_client: "a", for_partner: "b" },
    recommended_next_action: "Reach out.",
    is_sample: true,
    ...overrides,
  });
}

describe("candidate storage", () => {
  it("stores a candidate with sources and a calculated evaluation", async () => {
    const ws = await createWorkspace(env.DB, { name: "Test (fictional)", ownerEmail: "admin@talo.example" });
    const id = await insertCandidate(env.DB, ws.id, candidate(), "admin@talo.example", NOW);
    const stored = await getCandidate(env.DB, ws.id, id);
    expect(stored?.domain).toBe("northwind.example");
    expect(stored?.sources).toHaveLength(1);
    expect(stored?.sources[0]?.supports).toEqual(["alignment", "readiness"]);
    expect(stored?.evaluation).toEqual({
      overall_score: 73,
      evidence_confidence: "medium",
      verification_status: "ready",
    });
    expect(stored?.is_sample).toBe(true);
  });

  it("refuses a duplicate domain in the same workspace", async () => {
    const ws = await createWorkspace(env.DB, { name: "Dupes", ownerEmail: "admin@talo.example" });
    await insertCandidate(env.DB, ws.id, candidate(), "admin@talo.example", NOW);
    await expect(insertCandidate(env.DB, ws.id, candidate(), "admin@talo.example", NOW)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await listCandidates(env.DB, ws.id)).toHaveLength(1);
  });

  it("allows the same domain in different workspaces", async () => {
    const a = await createWorkspace(env.DB, { name: "A", ownerEmail: "admin@talo.example" });
    const b = await createWorkspace(env.DB, { name: "B", ownerEmail: "admin@talo.example" });
    await insertCandidate(env.DB, a.id, candidate(), "admin@talo.example", NOW);
    await insertCandidate(env.DB, b.id, candidate(), "admin@talo.example", NOW);
    expect(await listCandidates(env.DB, a.id)).toHaveLength(1);
    expect(await listCandidates(env.DB, b.id)).toHaveLength(1);
  });
});

describe("workspace isolation", () => {
  it("one workspace can never read another's candidates", async () => {
    const a = await createWorkspace(env.DB, { name: "Client A", ownerEmail: "admin@talo.example" });
    const b = await createWorkspace(env.DB, { name: "Client B", ownerEmail: "admin@talo.example" });
    const secretId = await insertCandidate(env.DB, a.id, candidate({ domain: "secret.example" }), "x", NOW);

    expect(await getCandidate(env.DB, b.id, secretId)).toBeNull();
    expect((await listCandidates(env.DB, b.id)).map((c) => c.domain)).not.toContain("secret.example");
    expect(await getCandidate(env.DB, a.id, secretId)).not.toBeNull();
  });

  it("every table except workspaces has a workspace_id column", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('workspaces', 'd1_migrations')",
    ).all<{ name: string }>();
    expect(results.length).toBeGreaterThanOrEqual(8);
    for (const { name } of results) {
      const cols = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>();
      expect(
        cols.results.map((c) => c.name),
        name,
      ).toContain("workspace_id");
    }
  });

  it("deleting a workspace removes all its data", async () => {
    const ws = await createWorkspace(env.DB, { name: "Gone", ownerEmail: "admin@talo.example" });
    const id = await insertCandidate(env.DB, ws.id, candidate({ domain: "gone.example" }), "x", NOW);
    await env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(ws.id).run();
    expect(await getCandidate(env.DB, ws.id, id)).toBeNull();
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM evidence_sources WHERE workspace_id = ?")
      .bind(ws.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("workspaces API", () => {
  it("creates and reads a workspace owned by the signed-in admin", async () => {
    const res = await call("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "Pilot (fictional)" }) });
    expect(res.status).toBe(201);
    const { workspace } = (await res.json()) as { workspace: { id: string; owner_email: string } };
    expect(workspace.owner_email).toBe("admin@talo.example");
    expect((await call(`/api/workspaces/${workspace.id}`)).status).toBe(200);
    const list = (await (await call("/api/workspaces")).json()) as { workspaces: { id: string }[] };
    expect(list.workspaces.map((w) => w.id)).toContain(workspace.id);
  });

  it("validates input", async () => {
    const res = await call("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect((await call("/api/workspaces", { method: "POST", body: "not json" })).status).toBe(400);
    expect(
      (await call("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "x", owner_email: "evil@x" }) }))
        .status,
    ).toBe(400);
  });

  it("returns 404 for an unknown workspace", async () => {
    expect((await call("/api/workspaces/does-not-exist")).status).toBe(404);
  });
});
