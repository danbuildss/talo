import { newId, nowIso } from "./util.ts";

export interface Workspace {
  id: string;
  name: string;
  owner_email: string;
  is_sample: boolean;
  created_at: string;
}

interface WorkspaceRow extends Omit<Workspace, "is_sample"> {
  is_sample: number;
}

const toWorkspace = (r: WorkspaceRow): Workspace => ({ ...r, is_sample: r.is_sample === 1 });

export async function createWorkspace(
  db: D1Database,
  input: { name: string; ownerEmail: string; isSample?: boolean },
  now = new Date(),
): Promise<Workspace> {
  const ws: Workspace = {
    id: newId(),
    name: input.name,
    owner_email: input.ownerEmail.toLowerCase(),
    is_sample: input.isSample ?? false,
    created_at: nowIso(now),
  };
  await db
    .prepare("INSERT INTO workspaces (id, name, owner_email, is_sample, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(ws.id, ws.name, ws.owner_email, ws.is_sample ? 1 : 0, ws.created_at)
    .run();
  return ws;
}

export async function listWorkspaces(db: D1Database): Promise<Workspace[]> {
  const { results } = await db.prepare("SELECT * FROM workspaces ORDER BY created_at").all<WorkspaceRow>();
  return results.map(toWorkspace);
}

export async function getWorkspace(db: D1Database, id: string): Promise<Workspace | null> {
  const row = await db.prepare("SELECT * FROM workspaces WHERE id = ?").bind(id).first<WorkspaceRow>();
  return row ? toWorkspace(row) : null;
}
