// src/registry/db.ts [B] — every D1 access for the registry (§6.3/§6.4).
// Rules: ONE db.batch per snapshot; every mutation is ONE db.batch = write(s) + catalog_version bump + registry_events row.
// No runtime DDL: a missing table surfaces as SchemaMissingError (isSchemaMissing) and callers degrade (§0.1).
// auth_value / tool_cache are never loaded into the snapshot; getUpstreamFull() is the only reader of those columns.
import { SchemaMissingError, type DefinedKind, type OverrideScope, type SettingsMap, type Snapshot, type ToolDefRow, type ToolOverrideRow, type UpstreamAuthKind, type UpstreamRow } from "../types";

export const DEFAULT_PROMOTED_BUDGET = 12;
/** define_tool refuses beyond this many rows in tool_defs (§6.3). */
export const MAX_DEFINITIONS = 200;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const BUMP_SQL = "UPDATE settings SET value = CAST(value AS INTEGER)+1 WHERE key='catalog_version'";
const EVENT_SQL = "INSERT INTO registry_events(actor, action, target, detail) VALUES (?1, ?2, ?3, ?4)";
const SETTING_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** §6.4 snapshot statements, verbatim. */
export const SNAPSHOT_SQL = {
  settings: "SELECT key,value FROM settings",
  defs: "SELECT * FROM tool_defs ORDER BY name",
  overrides: "SELECT * FROM tool_overrides WHERE scope='deploy' OR (scope='client' AND client_key=?1)",
  upstreams: "SELECT name,url,auth_kind,headers,server_info,cached_at,created_by,created_at FROM upstreams ORDER BY name"
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------
/** True for SchemaMissingError and for any D1/SQLite error chain whose message says `no such table`. */
export function isSchemaMissing(err: unknown): boolean {
  if (err instanceof SchemaMissingError) return true;
  if (typeof err === "string") return /no such table/i.test(err);
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const { message, cause } = cur as { message?: unknown; cause?: unknown };
    if (typeof message === "string" && /no such table/i.test(message)) return true;
    cur = cause;
  }
  return false;
}

async function run<T = unknown>(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> {
  try {
    return await db.batch<T>(stmts);
  } catch (e) {
    if (isSchemaMissing(e)) throw new SchemaMissingError(`registry schema missing: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

function bump(db: D1Database): D1PreparedStatement { return db.prepare(BUMP_SQL); }
function event(db: D1Database, actor: string, action: string, target: string, detail?: unknown): D1PreparedStatement {
  return db.prepare(EVENT_SQL).bind(actor, action, target, detail === undefined ? null : JSON.stringify(detail));
}
function intSetting(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function bit(v: unknown): 0 | 1 | null {
  if (v === null || v === undefined) return null;
  return Number(v) ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------------------------------
/** The built-in-only snapshot used when the database is not migrated (§0.1: no runtime DDL). */
export function emptySnapshot(): Snapshot {
  return { settings: {}, defs: [], overrides: [], upstreams: [], catalogVersion: 0, promotedBudget: DEFAULT_PROMOTED_BUDGET, schemaMissing: true };
}

/** ONE db.batch of the four §6.4 statements. Throws SchemaMissingError when D1 reports `no such table`. */
export async function loadSnapshot(db: D1Database, clientKey: string): Promise<Snapshot> {
  const [s, d, o, u] = await run(db, [
    db.prepare(SNAPSHOT_SQL.settings),
    db.prepare(SNAPSHOT_SQL.defs),
    db.prepare(SNAPSHOT_SQL.overrides).bind(clientKey),
    db.prepare(SNAPSHOT_SQL.upstreams)
  ]);
  const settings: SettingsMap = {};
  for (const row of (s?.results ?? []) as { key: string; value: unknown }[]) settings[String(row.key)] = String(row.value ?? "");
  const defs = ((d?.results ?? []) as Record<string, unknown>[]).map(normalizeDef);
  const overrides = ((o?.results ?? []) as Record<string, unknown>[]).map(normalizeOverride);
  const upstreams = ((u?.results ?? []) as Record<string, unknown>[]).map(normalizeUpstreamPublic);
  return {
    settings, defs, overrides, upstreams,
    catalogVersion: intSetting(settings.catalog_version, 1),
    promotedBudget: intSetting(settings.promoted_budget, DEFAULT_PROMOTED_BUDGET),
    schemaMissing: false
  };
}

function normalizeDef(r: Record<string, unknown>): ToolDefRow {
  return {
    name: String(r.name), kind: String(r.kind) as DefinedKind, title: String(r.title ?? ""), description: String(r.description ?? ""),
    input_schema: String(r.input_schema ?? "{}"), spec: String(r.spec ?? "{}"), annotations: String(r.annotations ?? "{}"),
    created_by: String(r.created_by ?? ""), created_at: String(r.created_at ?? ""), updated_at: String(r.updated_at ?? ""),
    version: Number(r.version ?? 1)
  };
}
function normalizeOverride(r: Record<string, unknown>): ToolOverrideRow {
  return {
    scope: (r.scope === "client" ? "client" : "deploy"), client_key: String(r.client_key ?? ""), tool_name: String(r.tool_name),
    enabled: bit(r.enabled), promoted: bit(r.promoted),
    title: r.title === null || r.title === undefined ? null : String(r.title),
    description: r.description === null || r.description === undefined ? null : String(r.description),
    updated_by: String(r.updated_by ?? ""), updated_at: String(r.updated_at ?? "")
  };
}
function normalizeUpstreamPublic(r: Record<string, unknown>): Snapshot["upstreams"][number] {
  return {
    name: String(r.name), url: String(r.url), auth_kind: String(r.auth_kind ?? "none") as UpstreamAuthKind, headers: String(r.headers ?? "{}"),
    server_info: r.server_info === null || r.server_info === undefined ? null : String(r.server_info),
    cached_at: r.cached_at === null || r.cached_at === undefined ? null : String(r.cached_at),
    created_by: String(r.created_by ?? ""), created_at: String(r.created_at ?? "")
  };
}

/** The full upstream row including auth_value and tool_cache — for connecting and for the cached tool list. Never put it in a result. */
export async function getUpstreamFull(db: D1Database, name: string): Promise<UpstreamRow | null> {
  const [r] = await run<Record<string, unknown>>(db, [db.prepare("SELECT * FROM upstreams WHERE name=?1").bind(name)]);
  const row = r?.results?.[0];
  if (!row) return null;
  return {
    ...normalizeUpstreamPublic(row),
    auth_value: row.auth_value === null || row.auth_value === undefined ? null : String(row.auth_value),
    tool_cache: row.tool_cache === null || row.tool_cache === undefined ? null : String(row.tool_cache)
  };
}

/** Override rows that apply to one tool for one client key (deploy row + that client's row). Used by describe_tool. */
export async function listOverridesFor(db: D1Database, toolName: string, clientKey: string): Promise<ToolOverrideRow[]> {
  const [r] = await run<Record<string, unknown>>(db, [
    db.prepare("SELECT * FROM tool_overrides WHERE tool_name=?1 AND (scope='deploy' OR (scope='client' AND client_key=?2)) ORDER BY scope").bind(toolName, clientKey)
  ]);
  return (r?.results ?? []).map(normalizeOverride);
}

/** Number of rows in tool_defs (the 200-row cap of define_tool). */
export async function countDefs(db: D1Database): Promise<number> {
  const [r] = await run<{ n: number }>(db, [db.prepare("SELECT count(*) AS n FROM tool_defs")]);
  return Number(r?.results?.[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Mutations — each ONE batch: write(s) + catalog_version bump + registry_events row
// ---------------------------------------------------------------------------------------------------------------------
export interface ToolDefInput { name: string; kind: DefinedKind; title: string; description: string; input_schema: string; spec: string; annotations: string; created_by: string }

function promoteDeployStmt(db: D1Database, toolName: string, actor: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO tool_overrides(scope, client_key, tool_name, promoted, updated_by) VALUES ('deploy', '', ?1, 1, ?2)
     ON CONFLICT(scope, client_key, tool_name) DO UPDATE SET promoted = 1, updated_by = excluded.updated_by, updated_at = ${NOW}`
  ).bind(toolName, actor);
}

/** Inserts a definition (enabled, hidden); `promote` adds the deploy override promoted=1 in the same batch. */
export async function insertDef(db: D1Database, row: ToolDefInput, promote: boolean, actor: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT INTO tool_defs(name, kind, title, description, input_schema, spec, annotations, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(row.name, row.kind, row.title, row.description, row.input_schema, row.spec, row.annotations, row.created_by)
  ];
  if (promote) stmts.push(promoteDeployStmt(db, row.name, actor));
  stmts.push(bump(db), event(db, actor, "tool.define", row.name, { kind: row.kind, promote }));
  await run(db, stmts);
}

/** Replaces a definition in place (version+1, updated_at now); overrides survive. Optional `promote` as in insertDef. */
export async function replaceDef(db: D1Database, row: ToolDefInput, actor: string, promote = false): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare(`UPDATE tool_defs SET kind = ?2, title = ?3, description = ?4, input_schema = ?5, spec = ?6, annotations = ?7, updated_at = ${NOW}, version = version + 1 WHERE name = ?1`)
      .bind(row.name, row.kind, row.title, row.description, row.input_schema, row.spec, row.annotations)
  ];
  if (promote) stmts.push(promoteDeployStmt(db, row.name, actor));
  stmts.push(bump(db), event(db, actor, "tool.replace", row.name, { kind: row.kind, promote }));
  await run(db, stmts);
}

/** Deletes a definition and every override row that names it. */
export async function deleteDef(db: D1Database, name: string, actor: string): Promise<void> {
  await run(db, [
    db.prepare("DELETE FROM tool_defs WHERE name = ?1").bind(name),
    db.prepare("DELETE FROM tool_overrides WHERE tool_name = ?1").bind(name),
    bump(db),
    event(db, actor, "tool.remove", name)
  ]);
}

/** Columns a caller may touch. `undefined` = untouched (keeps the current value); `null` = cleared. */
export interface OverridePatch { enabled?: boolean | null; promoted?: boolean | null; title?: string | null; description?: string | null }
const OVERRIDE_COLUMNS = ["enabled", "promoted", "title", "description"] as const;

/**
 * INSERT ... ON CONFLICT(scope, client_key, tool_name) DO UPDATE. Only the columns present in `patch` are written
 * (COALESCE semantics for untouched ones); a row left with all four columns NULL is pruned in the same batch.
 */
export async function upsertOverride(db: D1Database, scope: OverrideScope, clientKey: string, toolName: string, patch: OverridePatch, actor: string): Promise<void> {
  const key = scope === "deploy" ? "" : clientKey;
  const touched = OVERRIDE_COLUMNS.filter((c) => patch[c] !== undefined);
  const setClause = [...touched.map((c) => `${c} = excluded.${c}`), "updated_by = excluded.updated_by", `updated_at = ${NOW}`].join(", ");
  const toBit = (v: boolean | null | undefined): 0 | 1 | null => (v === null || v === undefined ? null : v ? 1 : 0);
  await run(db, [
    db.prepare(
      `INSERT INTO tool_overrides(scope, client_key, tool_name, enabled, promoted, title, description, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(scope, client_key, tool_name) DO UPDATE SET ${setClause}`
    ).bind(scope, key, toolName, toBit(patch.enabled), toBit(patch.promoted), patch.title ?? null, patch.description ?? null, actor),
    db.prepare("DELETE FROM tool_overrides WHERE scope = ?1 AND client_key = ?2 AND tool_name = ?3 AND enabled IS NULL AND promoted IS NULL AND title IS NULL AND description IS NULL")
      .bind(scope, key, toolName),
    bump(db),
    event(db, actor, "override.set", toolName, { scope, clientKey: key, patch })
  ]);
}

/** Removes one override row (e.g. a client re-enabling a tool it had switched off). */
export async function deleteOverride(db: D1Database, scope: OverrideScope, clientKey: string, toolName: string, actor: string): Promise<void> {
  const key = scope === "deploy" ? "" : clientKey;
  await run(db, [
    db.prepare("DELETE FROM tool_overrides WHERE scope = ?1 AND client_key = ?2 AND tool_name = ?3").bind(scope, key, toolName),
    bump(db),
    event(db, actor, "override.clear", toolName, { scope, clientKey: key })
  ]);
}

/** Writes settings; a `null` value deletes the key. `catalog_version` is never writable here. */
export async function setSettings(db: D1Database, values: Record<string, string | null>, actor: string): Promise<void> {
  const keys = Object.keys(values);
  if (keys.length === 0) return;
  for (const key of keys) {
    if (!SETTING_KEY_RE.test(key) || key === "catalog_version") throw new Error(`setting '${key}' is not writable`);
  }
  const stmts: D1PreparedStatement[] = keys.map((key) => {
    const value = values[key];
    return value === null
      ? db.prepare("DELETE FROM settings WHERE key = ?1").bind(key)
      : db.prepare(`INSERT INTO settings(key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ${NOW}) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .bind(key, value, actor);
  });
  const detail = {
    set: Object.fromEntries(keys.filter((k) => values[k] !== null).map((k) => [k, String(values[k]).slice(0, 200)])),
    cleared: keys.filter((k) => values[k] === null)
  };
  stmts.push(bump(db), event(db, actor, "settings.set", keys.join(","), detail));
  await run(db, stmts);
}

export interface UpstreamInput { name: string; url: string; auth_kind: UpstreamAuthKind; auth_value: string | null; headers: string; server_info?: string | null; tool_cache?: string | null; created_by: string }

/** Inserts an upstream; when a tool_cache is supplied cached_at is set in the same statement. The event never records auth_value. */
export async function insertUpstream(db: D1Database, row: UpstreamInput, actor: string): Promise<void> {
  const toolCache = row.tool_cache ?? null;
  await run(db, [
    db.prepare(
      `INSERT INTO upstreams(name, url, auth_kind, auth_value, headers, server_info, tool_cache, cached_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?7 IS NULL THEN NULL ELSE ${NOW} END, ?8)`
    ).bind(row.name, row.url, row.auth_kind, row.auth_value, row.headers, row.server_info ?? null, toolCache, row.created_by),
    bump(db),
    event(db, actor, "upstream.add", row.name, { url: row.url, auth_kind: row.auth_kind })
  ]);
}

/**
 * Refreshes the cached server_info / tool list of an upstream. This is a cache write, not a catalog change: no
 * catalog_version bump and no registry_events row (the §7.2 signature carries no actor). Values are JSON-encoded here.
 */
export async function updateUpstreamCache(db: D1Database, name: string, serverInfo: unknown, toolCache: unknown): Promise<void> {
  const enc = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));
  await run(db, [
    db.prepare(`UPDATE upstreams SET server_info = ?2, tool_cache = ?3, cached_at = ${NOW} WHERE name = ?1`).bind(name, enc(serverInfo), enc(toolCache))
  ]);
}

/** Deletes an upstream row. Callers delete dependent mcp definitions first (remove_upstream --force). */
export async function deleteUpstream(db: D1Database, name: string, actor: string): Promise<void> {
  await run(db, [
    db.prepare("DELETE FROM upstreams WHERE name = ?1").bind(name),
    bump(db),
    event(db, actor, "upstream.remove", name)
  ]);
}

export interface RegistryEvent { id: number; at: string; actor: string; action: string; target: string; detail: unknown }

/** Newest events first (owner console Log tab, default 100). */
export async function listEvents(db: D1Database, limit = 100): Promise<RegistryEvent[]> {
  const n = Math.max(1, Math.min(1000, Math.floor(limit)));
  const [r] = await run<Record<string, unknown>>(db, [
    db.prepare("SELECT id, at, actor, action, target, detail FROM registry_events ORDER BY id DESC LIMIT ?1").bind(n)
  ]);
  return (r?.results ?? []).map((row) => {
    let detail: unknown = row.detail ?? null;
    if (typeof detail === "string") { try { detail = JSON.parse(detail); } catch { /* keep the raw string */ } }
    return { id: Number(row.id), at: String(row.at), actor: String(row.actor), action: String(row.action), target: String(row.target), detail };
  });
}
