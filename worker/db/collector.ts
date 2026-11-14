/**
 * The collector: reads watched sources on a schedule and puts what's new in the
 * inbox (collected_items). It never creates or verifies signals: a person does.
 *
 * Politeness and limits: a few due sources per run, conditional requests
 * (ETag / Last-Modified), a timeout per fetch, backoff after failures, and a
 * pause after MAX_FAILURES so a broken source gets a person's attention.
 */

import { normalizeDomain } from "../../shared/candidate.ts";
import {
  type Adapter,
  backoffHours,
  type CollectedItem,
  excerpt,
  MAX_FAILURES,
  pageFingerprint,
  parseFeed,
  parseGithubReleases,
  parseGithubRepo,
  parseKeyMap,
  parseMcpRegistry,
  suggestSignalType,
  type WatchedSourceInput,
} from "../../shared/collector.ts";
import { normalizeUrl, type SourceKind } from "../../shared/registry.ts";
import type { SignalType } from "../../shared/signals.ts";
import { ConflictError, NotFoundError, newId, nowIso } from "./util.ts";

export const USER_AGENT = "TaloCollector/0.1 (+https://github.com/danbuildss/talo)";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ITEMS_PER_RUN = 25;
const MAX_BODY_BYTES = 2_000_000;

export interface WatchedSource {
  id: string;
  name: string;
  adapter: Adapter;
  url: string;
  config: { format?: "mcp_registry" | "key_map"; label?: string };
  terms_note: string;
  company_domain: string | null;
  signal_type_hint: SignalType | null;
  interval_hours: number;
  enabled: boolean;
  next_run_at: string;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

interface WatchedRow extends Omit<WatchedSource, "config" | "enabled"> {
  config_json: string;
  enabled: number;
  etag: string | null;
  last_modified: string | null;
  state_json: string;
}

const toSource = (r: WatchedRow): WatchedSource => ({
  id: r.id,
  name: r.name,
  adapter: r.adapter,
  url: r.url,
  config: JSON.parse(r.config_json),
  terms_note: r.terms_note,
  company_domain: r.company_domain,
  signal_type_hint: r.signal_type_hint,
  interval_hours: r.interval_hours,
  enabled: r.enabled === 1,
  next_run_at: r.next_run_at,
  last_success_at: r.last_success_at,
  last_error: r.last_error,
  consecutive_failures: r.consecutive_failures,
});

const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000).toISOString();

export async function createWatchedSource(
  db: D1Database,
  input: WatchedSourceInput,
  createdBy: string,
  now = new Date(),
): Promise<WatchedSource> {
  if (input.adapter === "github_releases" && !parseGithubRepo(input.url)) {
    throw new ConflictError("github_releases needs a repository link like https://github.com/owner/repo");
  }
  if (input.adapter === "registry_listing" && !input.config.format) {
    throw new ConflictError("registry_listing needs config.format (mcp_registry or key_map)");
  }
  const domain = input.company_domain ? normalizeDomain(input.company_domain) : null;
  if (input.company_domain && !domain) throw new ConflictError("company_domain isn't a valid domain");
  const id = newId();
  const at = nowIso(now);
  try {
    await db
      .prepare(
        `INSERT INTO watched_sources (id, name, adapter, url, config_json, terms_note, company_domain, signal_type_hint,
          interval_hours, enabled, next_run_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.name,
        input.adapter,
        input.url,
        JSON.stringify(input.config),
        input.terms_note,
        domain,
        input.signal_type_hint ?? null,
        input.interval_hours,
        input.enabled ? 1 : 0,
        at, // due straight away
        createdBy,
        at,
        at,
      )
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw new ConflictError("this source is already watched");
    }
    throw err;
  }
  return (await getWatchedSource(db, id)) as WatchedSource;
}

export async function getWatchedSource(db: D1Database, id: string): Promise<WatchedSource | null> {
  const row = await db.prepare("SELECT * FROM watched_sources WHERE id = ?").bind(id).first<WatchedRow>();
  return row ? toSource(row) : null;
}

export async function listWatchedSources(db: D1Database): Promise<WatchedSource[]> {
  const { results } = await db.prepare("SELECT * FROM watched_sources ORDER BY name").all<WatchedRow>();
  return results.map(toSource);
}

/** Enable or pause a source, or change how often it's checked. Re-enabling clears the failure count. */
export async function updateWatchedSource(
  db: D1Database,
  id: string,
  patch: { enabled?: boolean; interval_hours?: number },
  now = new Date(),
): Promise<WatchedSource> {
  const s = await getWatchedSource(db, id);
  if (!s) throw new NotFoundError("watched source not found");
  const enabled = patch.enabled ?? s.enabled;
  const reenabled = enabled && !s.enabled;
  await db
    .prepare(
      `UPDATE watched_sources SET enabled = ?, interval_hours = ?, updated_at = ?,
         consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures END,
         next_run_at = CASE WHEN ? THEN ? ELSE next_run_at END
       WHERE id = ?`,
    )
    .bind(
      enabled ? 1 : 0,
      patch.interval_hours ?? s.interval_hours,
      nowIso(now),
      reenabled ? 1 : 0,
      reenabled ? 1 : 0,
      nowIso(now),
      id,
    )
    .run();
  return (await getWatchedSource(db, id)) as WatchedSource;
}

class FetchError extends Error {}

async function politeFetch(
  fetcher: typeof fetch,
  url: string,
  row: Pick<WatchedRow, "etag" | "last_modified">,
  headers: Record<string, string>,
): Promise<
  { status: "not_modified" } | { status: "ok"; body: string; etag: string | null; lastModified: string | null }
> {
  const h = new Headers({ "user-agent": USER_AGENT, ...headers });
  if (row.etag) h.set("if-none-match", row.etag);
  if (row.last_modified) h.set("if-modified-since", row.last_modified);
  let res: Response;
  try {
    res = await fetcher(url, { headers: h, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new FetchError(`could not reach ${new URL(url).host}: ${err instanceof Error ? err.name : "error"}`);
  }
  if (res.status === 304) return { status: "not_modified" };
  if (!res.ok) throw new FetchError(`${new URL(url).host} answered ${res.status}`);
  const body = await res.text();
  if (body.length > MAX_BODY_BYTES) throw new FetchError("response too large");
  return { status: "ok", body, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
}

const SOURCE_KIND: Record<Adapter, SourceKind> = {
  rss: "rss_item",
  github_releases: "github_release",
  page_watch: "partner_page",
  registry_listing: "registry_entry",
};

interface AdapterResult {
  items: CollectedItem[];
  state: Record<string, unknown>;
}

async function runAdapter(source: WatchedSource, body: string, state: Record<string, unknown>): Promise<AdapterResult> {
  switch (source.adapter) {
    case "rss":
      return { items: parseFeed(body), state };
    case "github_releases": {
      const repo = parseGithubRepo(source.url);
      return { items: parseGithubReleases(JSON.parse(body), repo ? `${repo.owner}/${repo.repo}` : source.name), state };
    }
    case "page_watch": {
      const fp = await pageFingerprint(body);
      const first = typeof state.hash !== "string";
      const changed = !first && state.hash !== fp.hash;
      // The first run only records the page; a later change becomes one item to review.
      const items: CollectedItem[] = changed
        ? [
            {
              url: `${source.url}${source.url.includes("?") ? "&" : "?"}talo_seen=${fp.hash.slice(0, 12)}`,
              title: `Page changed: ${fp.title ?? source.name}`.slice(0, 300),
              published_at: null,
              excerpt: excerpt(fp.text),
              domain: null,
            },
          ]
        : [];
      return { items, state: { ...state, hash: fp.hash } };
    }
    case "registry_listing": {
      const json = JSON.parse(body);
      if (source.config.format === "mcp_registry") return { items: parseMcpRegistry(json, source.url), state };
      // key_map: only keys not seen before count as new. The first run records them all.
      const entries = parseKeyMap(json, source.config.label ?? source.name);
      const seen = new Set(Array.isArray(state.keys) ? (state.keys as string[]) : []);
      const first = !Array.isArray(state.keys);
      const fresh = first ? [] : entries.filter((e) => !seen.has(e.key)).map((e) => e.item);
      return { items: fresh, state: { ...state, keys: entries.map((e) => e.key) } };
    }
  }
}

function requestFor(
  source: WatchedSource,
  env: { GITHUB_TOKEN?: string },
): { url: string; headers: Record<string, string> } {
  if (source.adapter === "github_releases") {
    const repo = parseGithubRepo(source.url);
    if (!repo) throw new FetchError("not a GitHub repository link");
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
    return { url: `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=10`, headers };
  }
  return {
    url: source.url,
    headers:
      source.adapter === "rss"
        ? { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }
        : {},
  };
}

export interface RunOutcome {
  source_id: string;
  status: "ok" | "not_modified" | "failed";
  items_seen: number;
  items_new: number;
  error?: string;
  paused?: boolean;
}

/** Check one source now and record the outcome. Never throws for source problems. */
export async function runSource(
  db: D1Database,
  sourceId: string,
  options: { fetcher?: typeof fetch; env?: { GITHUB_TOKEN?: string }; now?: Date } = {},
): Promise<RunOutcome> {
  const now = options.now ?? new Date();
  const fetcher = options.fetcher ?? fetch;
  const row = await db.prepare("SELECT * FROM watched_sources WHERE id = ?").bind(sourceId).first<WatchedRow>();
  if (!row) throw new NotFoundError("watched source not found");
  const source = toSource(row);
  const startedAt = nowIso(now);
  let outcome: RunOutcome;
  const statements: D1PreparedStatement[] = [];

  try {
    const req = requestFor(source, options.env ?? {});
    const res = await politeFetch(fetcher, req.url, row, req.headers);
    if (res.status === "not_modified") {
      outcome = { source_id: source.id, status: "not_modified", items_seen: 0, items_new: 0 };
      statements.push(
        db
          .prepare(
            "UPDATE watched_sources SET last_success_at = ?, last_error = NULL, consecutive_failures = 0, next_run_at = ?, updated_at = ? WHERE id = ?",
          )
          .bind(startedAt, addHours(now, source.interval_hours), startedAt, source.id),
      );
    } else {
      let result: AdapterResult;
      try {
        result = await runAdapter(source, res.body, JSON.parse(row.state_json));
      } catch (err) {
        throw new FetchError(
          `couldn't read the response (${err instanceof Error ? err.name : "error"}); the format may have changed`,
        );
      }
      const items = result.items.slice(0, MAX_ITEMS_PER_RUN);
      let fresh = 0;
      const seenThisRun = new Set<string>();
      for (const item of items) {
        const url = normalizeUrl(item.url);
        // A source can list the same link twice in one response: keep the first.
        if (!url || seenThisRun.has(url)) continue;
        seenThisRun.add(url);
        const known = await db.prepare("SELECT 1 FROM sources WHERE url = ?").bind(url).first();
        if (known) continue;
        fresh += 1;
        const sourceId = newId();
        statements.push(
          db
            .prepare(
              `INSERT INTO sources (id, url, kind, company_id, title, published_at, excerpt, first_seen_at, last_fetched_at)
               VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
            )
            .bind(
              sourceId,
              url,
              SOURCE_KIND[source.adapter],
              item.title,
              item.published_at,
              item.excerpt,
              startedAt,
              startedAt,
            ),
          db
            .prepare(
              `INSERT INTO collected_items (id, watched_source_id, source_id, title, url, published_at, excerpt,
                 suggested_signal_type, suggested_domain, found_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              newId(),
              source.id,
              sourceId,
              item.title,
              url,
              item.published_at,
              item.excerpt,
              suggestSignalType(item, source.signal_type_hint),
              item.domain ?? source.company_domain,
              startedAt,
              startedAt,
            ),
        );
      }
      outcome = { source_id: source.id, status: "ok", items_seen: items.length, items_new: fresh };
      statements.push(
        db
          .prepare(
            `UPDATE watched_sources SET last_success_at = ?, last_error = NULL, consecutive_failures = 0, next_run_at = ?,
               etag = ?, last_modified = ?, state_json = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(
            startedAt,
            addHours(now, source.interval_hours),
            res.etag,
            res.lastModified,
            JSON.stringify(result.state),
            startedAt,
            source.id,
          ),
      );
    }
  } catch (err) {
    if (!(err instanceof FetchError)) {
      console.error(`collector: unexpected error on ${source.id}: ${err instanceof Error ? err.name : "error"}`);
    }
    const message = err instanceof FetchError ? err.message : "unexpected error while checking this source";
    const failures = source.consecutive_failures + 1;
    const paused = failures >= MAX_FAILURES;
    outcome = { source_id: source.id, status: "failed", items_seen: 0, items_new: 0, error: message, paused };
    statements.push(
      db
        .prepare(
          "UPDATE watched_sources SET last_error = ?, consecutive_failures = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(
          message,
          failures,
          paused ? 0 : row.enabled,
          addHours(now, backoffHours(source.interval_hours, failures)),
          startedAt,
          source.id,
        ),
    );
  }

  const runStatement = (o: RunOutcome) =>
    db
      .prepare(
        `INSERT INTO ingestion_runs (id, watched_source_id, started_at, finished_at, status, items_seen, items_new, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId(), source.id, startedAt, nowIso(), o.status, o.items_seen, o.items_new, o.error ?? null);
  try {
    await db.batch([...statements, runStatement(outcome)]);
  } catch (err) {
    // Saving failed (e.g. a race with another run): record a failed run so the
    // problem is visible and the other sources still get checked.
    console.error(`collector: saving results for ${source.id} failed: ${err instanceof Error ? err.name : "error"}`);
    outcome = {
      source_id: source.id,
      status: "failed",
      items_seen: 0,
      items_new: 0,
      error: "couldn't save this run's results",
    };
    await db.batch([
      db
        .prepare("UPDATE watched_sources SET last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
        .bind(outcome.error ?? null, addHours(now, source.interval_hours), startedAt, source.id),
      runStatement(outcome),
    ]);
  }
  return outcome;
}

/** The scheduled job: check up to `limit` enabled sources that are due, oldest first. */
export async function runDueSources(
  db: D1Database,
  options: { fetcher?: typeof fetch; env?: { GITHUB_TOKEN?: string }; now?: Date; limit?: number } = {},
): Promise<RunOutcome[]> {
  const now = options.now ?? new Date();
  const { results } = await db
    .prepare("SELECT id FROM watched_sources WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?")
    .bind(nowIso(now), options.limit ?? 5)
    .all<{ id: string }>();
  const outcomes: RunOutcome[] = [];
  for (const { id } of results) {
    try {
      outcomes.push(await runSource(db, id, { ...options, now }));
    } catch (err) {
      // One broken source must never stop the others.
      console.error(`collector: ${id} could not be checked: ${err instanceof Error ? err.name : "error"}`);
    }
  }
  return outcomes;
}

export async function listRuns(db: D1Database, sourceId?: string, limit = 50) {
  const { results } = await db
    .prepare(
      `SELECT r.*, w.name AS source_name FROM ingestion_runs r JOIN watched_sources w ON w.id = r.watched_source_id
       ${sourceId ? "WHERE r.watched_source_id = ?" : ""} ORDER BY r.started_at DESC LIMIT ?`,
    )
    .bind(...(sourceId ? [sourceId] : []), Math.min(Math.max(limit, 1), 200))
    .all();
  return results;
}

export interface InboxItem {
  id: string;
  watched_source_id: string;
  source_name: string;
  title: string;
  url: string;
  published_at: string | null;
  excerpt: string | null;
  suggested_signal_type: SignalType | null;
  suggested_domain: string | null;
  status: "new" | "promoted" | "dismissed";
  signal_id: string | null;
  found_at: string;
}

export async function listInbox(
  db: D1Database,
  status: InboxItem["status"] = "new",
  limit = 100,
): Promise<InboxItem[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.watched_source_id, w.name AS source_name, i.title, i.url, i.published_at, i.excerpt,
         i.suggested_signal_type, i.suggested_domain, i.status, i.signal_id, i.found_at
       FROM collected_items i JOIN watched_sources w ON w.id = i.watched_source_id
       WHERE i.status = ? ORDER BY COALESCE(i.published_at, substr(i.found_at, 1, 10)) DESC LIMIT ?`,
    )
    .bind(status, Math.min(Math.max(limit, 1), 500))
    .all<InboxItem>();
  return results;
}

export async function getInboxItem(db: D1Database, id: string): Promise<InboxItem | null> {
  return db
    .prepare(
      `SELECT i.id, i.watched_source_id, w.name AS source_name, i.title, i.url, i.published_at, i.excerpt,
         i.suggested_signal_type, i.suggested_domain, i.status, i.signal_id, i.found_at
       FROM collected_items i JOIN watched_sources w ON w.id = i.watched_source_id WHERE i.id = ?`,
    )
    .bind(id)
    .first<InboxItem>();
}

/** Mark an inbox item as handled: dismissed, or promoted to the given signal. */
export async function closeInboxItem(
  db: D1Database,
  id: string,
  outcome: { status: "dismissed" } | { status: "promoted"; signalId: string },
  reviewer: string,
  now = new Date(),
) {
  const item = await getInboxItem(db, id);
  if (!item) throw new NotFoundError("inbox item not found");
  if (item.status !== "new") throw new ConflictError(`this item was already ${item.status}`);
  await db
    .prepare("UPDATE collected_items SET status = ?, signal_id = ?, reviewed_by = ?, updated_at = ? WHERE id = ?")
    .bind(outcome.status, outcome.status === "promoted" ? outcome.signalId : null, reviewer, nowIso(now), id)
    .run();
}
