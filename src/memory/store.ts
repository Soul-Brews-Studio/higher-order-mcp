// src/memory/store.ts [D] — the memory core over D1 (§6.2 DDL, §7.2 signatures).
//
// recall() has three modes: "fts" (FTS5 `memories_fts` MATCH, ranked by bm25), "like" (LIKE over title/content/tags_text
// when FTS5 is unavailable — memoised per isolate in `ftsBroken`), and "recent" (empty query → importance DESC, updated_at DESC).
// Every function throws SchemaMissingError (src/types.ts) when D1 reports a missing table so the tools can answer
// `db_not_migrated`; nothing here runs DDL (no runtime migrations, §0.1).
import { SchemaMissingError } from "../types";

export const MEMORY_KINDS = ["note", "decision", "lesson", "context", "person", "project"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MAX_CONTENT = 12_000;
export const MAX_TITLE = 160;
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 64;
export const MAX_QUERY = 240;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;
export const DEFAULT_IMPORTANCE = 3;
/** memoryStats scans at most this many recent rows to compute the top tags (bounded D1 reads). */
export const TAG_SCAN_ROWS = 500;
export const TOP_TAGS = 10;

/** Raw D1 row (tags is the JSON text stored in the column). */
export interface MemoryRow {
  id: string; title: string; content: string; kind: MemoryKind; tags: string; tags_text: string;
  importance: number; created_by: string; created_at: string; updated_at: string;
}
/** Parsed memory (tags as an array) — what the tools return. */
export interface Memory {
  id: string; title: string; content: string; kind: MemoryKind; tags: string[];
  importance: number; created_by: string; created_at: string; updated_at: string;
}

export interface RememberInput { content: string; title?: string; kind?: MemoryKind; tags?: string[]; importance?: number }
export interface RecallQuery { query?: string; kind?: MemoryKind; tag?: string; limit?: number }
export type RecallMode = "fts" | "like" | "recent";
export interface RecallResult { rows: Memory[]; mode: RecallMode; query: string; terms: string[] }
export interface RevisePatch { title?: string; content?: string; kind?: MemoryKind; tags?: string[]; importance?: number }
export interface MemoryStats {
  total: number; byKind: Record<MemoryKind, number>; topTags: { tag: string; count: number }[];
  latestUpdatedAt: string | null; fts: "on" | "off";
}

// ---------------------------------------------------------------------------------------------------------------------
// FTS availability (memoised per isolate)
// ---------------------------------------------------------------------------------------------------------------------
let ftsBroken = false;
/** True once a MATCH query failed in this isolate (recall then uses LIKE until memoryStats probes FTS successfully). */
export function isFtsBroken(): boolean { return ftsBroken; }
/** Test hook / manual reset: forget that FTS failed so the next recall tries MATCH again. */
export function resetFtsState(): void { ftsBroken = false; }

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function messageOf(err: unknown): string {
  return err instanceof Error ? `${err.message}${err.cause ? ` (${String((err.cause as Error).message ?? err.cause)})` : ""}` : String(err);
}
/** D1 reports a missing table as `D1_ERROR: no such table: <name>: SQLITE_ERROR` (miniflare and the edge agree). */
export function isMissingTable(err: unknown): boolean { return /no such table/i.test(messageOf(err)); }
function mentionsFts(err: unknown): boolean { return /memories_fts/i.test(messageOf(err)); }

/** Runs a D1 operation; a missing `memories*` table becomes SchemaMissingError (the tools map it to db_not_migrated). */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (isMissingTable(e)) throw new SchemaMissingError(`memory tables are not migrated: ${messageOf(e)}`);
    throw e;
  }
}

function clampInt(n: number | undefined, min: number, max: number, dflt: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Title default (§11): the first non-empty line of the content, whitespace-collapsed, trimmed to 160 chars. */
export function defaultTitle(content: string): string {
  const line = content.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).find((l) => l.length > 0) ?? "";
  return (line || "Untitled").slice(0, MAX_TITLE);
}

/** Trim, drop empties, dedupe (first occurrence wins), cut each to 64 chars, keep at most 10. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of tags ?? []) {
    if (typeof raw !== "string") continue;
    const tag = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Splits a free-text query into terms that carry at least one letter or digit (pure punctuation would match nothing). */
export function queryTerms(query: string | undefined): string[] {
  return (query ?? "").slice(0, MAX_QUERY).split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));
}
/** FTS5 MATCH expression: every term becomes a quoted phrase (embedded quotes doubled) so no term can be parsed as syntax. */
export function toMatchExpression(terms: readonly string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}
function escapeLike(s: string): string { return s.replace(/[\\%_]/g, (c) => `\\${c}`); }

export function parseRow(row: MemoryRow): Memory {
  let tags: string[] = [];
  try { const parsed: unknown = JSON.parse(row.tags || "[]"); if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string"); }
  catch { tags = []; }
  return { id: row.id, title: row.title, content: row.content, kind: row.kind, tags, importance: row.importance, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at };
}

function filterClauses(q: RecallQuery, binds: unknown[]): string[] {
  const clauses: string[] = [];
  if (q.kind) { clauses.push("m.kind = ?"); binds.push(q.kind); }
  const tag = q.tag?.trim();
  if (tag) { clauses.push("EXISTS (SELECT 1 FROM json_each(m.tags) WHERE json_each.value = ?)"); binds.push(tag); }
  return clauses;
}

// ---------------------------------------------------------------------------------------------------------------------
// remember
// ---------------------------------------------------------------------------------------------------------------------
export async function remember(db: D1Database, input: RememberInput, actor: string): Promise<Memory> {
  const content = String(input.content ?? "").slice(0, MAX_CONTENT);
  if (!content.trim()) throw new Error("content is empty");
  const id = crypto.randomUUID();
  const title = (input.title?.replace(/\s+/g, " ").trim() || defaultTitle(content)).slice(0, MAX_TITLE);
  const kind: MemoryKind = input.kind && (MEMORY_KINDS as readonly string[]).includes(input.kind) ? input.kind : "note";
  const tags = normalizeTags(input.tags);
  const importance = clampInt(input.importance, 1, 5, DEFAULT_IMPORTANCE);
  const row = await guard(() =>
    db.prepare(
      "INSERT INTO memories (id, title, content, kind, tags, tags_text, importance, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING *"
    ).bind(id, title, content, kind, JSON.stringify(tags), tags.join(" "), importance, actor || "unknown").first<MemoryRow>()
  );
  if (!row) throw new Error("insert returned no row");
  return parseRow(row);
}

// ---------------------------------------------------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------------------------------------------------
export async function recall(db: D1Database, q: RecallQuery): Promise<RecallResult> {
  const limit = clampInt(q.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const query = (q.query ?? "").trim().slice(0, MAX_QUERY);
  const terms = queryTerms(query);

  if (terms.length === 0) {                                                                       // recent mode
    const binds: unknown[] = [];
    const where = filterClauses(q, binds);
    binds.push(limit);
    const sql = `SELECT m.* FROM memories m${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`;
    const res = await guard(() => db.prepare(sql).bind(...binds).all<MemoryRow>());
    return { rows: res.results.map(parseRow), mode: "recent", query, terms };
  }

  if (!ftsBroken) {                                                                               // fts mode
    const binds: unknown[] = [toMatchExpression(terms)];
    const where = filterClauses(q, binds);
    binds.push(limit);
    const sql = `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?${where.length ? ` AND ${where.join(" AND ")}` : ""} ORDER BY bm25(memories_fts) LIMIT ?`;
    try {
      const res = await db.prepare(sql).bind(...binds).all<MemoryRow>();
      return { rows: res.results.map(parseRow), mode: "fts", query, terms };
    } catch (e) {
      if (isMissingTable(e) && !mentionsFts(e)) throw new SchemaMissingError(`memory tables are not migrated: ${messageOf(e)}`);
      ftsBroken = true;                                                                            // memoised per isolate (§11)
      console.warn("memory: FTS5 MATCH failed, falling back to LIKE for this isolate:", messageOf(e));
    }
  }

  const binds: unknown[] = [];                                                                    // like mode
  const termClauses = terms.map((t) => {
    const pattern = `%${escapeLike(t)}%`;
    binds.push(pattern, pattern, pattern);
    return "(m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\' OR m.tags_text LIKE ? ESCAPE '\\')";
  });
  const where = [...termClauses, ...filterClauses(q, binds)];
  binds.push(limit);
  const sql = `SELECT m.* FROM memories m WHERE ${where.join(" AND ")} ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`;
  const res = await guard(() => db.prepare(sql).bind(...binds).all<MemoryRow>());
  return { rows: res.results.map(parseRow), mode: "like", query, terms };
}

// ---------------------------------------------------------------------------------------------------------------------
// read / revise / forget
// ---------------------------------------------------------------------------------------------------------------------
export async function readMemory(db: D1Database, id: string): Promise<Memory | null> {
  const row = await guard(() => db.prepare("SELECT * FROM memories WHERE id = ?1").bind(id).first<MemoryRow>());
  return row ? parseRow(row) : null;
}

/** COALESCE patch: only the provided fields change; id and created_at are kept; updated_at is bumped. Null when the id is unknown. */
export async function reviseMemory(db: D1Database, id: string, patch: RevisePatch): Promise<Memory | null> {
  const title = patch.title !== undefined ? patch.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || null : null;
  const content = patch.content !== undefined ? patch.content.slice(0, MAX_CONTENT) || null : null;
  const kind = patch.kind !== undefined && (MEMORY_KINDS as readonly string[]).includes(patch.kind) ? patch.kind : null;
  const tags = patch.tags !== undefined ? normalizeTags(patch.tags) : null;
  const importance = patch.importance !== undefined ? clampInt(patch.importance, 1, 5, DEFAULT_IMPORTANCE) : null;
  const row = await guard(() =>
    db.prepare(
      `UPDATE memories SET title = COALESCE(?1, title), content = COALESCE(?2, content), kind = COALESCE(?3, kind), ` +
      `tags = COALESCE(?4, tags), tags_text = COALESCE(?5, tags_text), importance = COALESCE(?6, importance), updated_at = ${NOW_SQL} ` +
      `WHERE id = ?7 RETURNING *`
    ).bind(title, content, kind, tags ? JSON.stringify(tags) : null, tags ? tags.join(" ") : null, importance, id).first<MemoryRow>()
  );
  return row ? parseRow(row) : null;
}

/** True when a row was deleted. */
export async function forgetMemory(db: D1Database, id: string): Promise<boolean> {
  const res = await guard(() => db.prepare("DELETE FROM memories WHERE id = ?1").bind(id).run());
  return (res.meta?.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------------------------------------------------
export async function memoryStats(db: D1Database): Promise<MemoryStats> {
  const [kinds, agg, tagRows] = await guard(() => db.batch([
    db.prepare("SELECT kind, count(*) AS n FROM memories GROUP BY kind"),
    db.prepare("SELECT count(*) AS total, max(updated_at) AS latest FROM memories"),
    db.prepare(`SELECT tags FROM memories WHERE tags != '[]' ORDER BY updated_at DESC LIMIT ${TAG_SCAN_ROWS}`)
  ]));
  const byKind = Object.fromEntries(MEMORY_KINDS.map((k) => [k, 0])) as Record<MemoryKind, number>;
  for (const r of (kinds.results as { kind: string; n: number }[])) if (r.kind in byKind) byKind[r.kind as MemoryKind] = Number(r.n);
  const first = (agg.results as { total: number; latest: string | null }[])[0];
  const total = Number(first?.total ?? 0);
  const latestUpdatedAt = first?.latest ?? null;
  const counts = new Map<string, number>();
  for (const r of (tagRows.results as { tags: string }[])) {
    for (const tag of parseRow({ tags: r.tags } as MemoryRow).tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const topTags = [...counts.entries()].map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)).slice(0, TOP_TAGS);
  let fts: "on" | "off";
  try { await db.prepare("SELECT count(*) FROM memories_fts WHERE memories_fts MATCH 'x'").first(); fts = "on"; ftsBroken = false; }
  catch (e) { fts = "off"; ftsBroken = true; console.warn("memory: FTS5 probe failed:", messageOf(e)); }
  return { total, byKind, topTags, latestUpdatedAt, fts };
}
