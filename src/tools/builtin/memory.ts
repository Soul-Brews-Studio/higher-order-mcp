// src/tools/builtin/memory.ts [D] — the six memory tools of §11: remember, recall, read_memory, revise_memory,
// forget_memory, memory_stats. Every tool: title, description (≤ 400 chars), z.object inputSchema, all four hints,
// structuredContent next to text. Errors use the §12.5 contract via ok()/fail(); tools never throw.
//
// Defaults use `.default(x).optional()` on purpose: zod 4's output-mode JSON Schema marks a bare `.default()` field as
// required, which would make clients think `limit`/`kind`/`importance` are mandatory; the optional wrapper keeps the
// field optional in the schema while `~standard.validate` still fills the default (verified against zod 4.5.4).
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { ok, fail } from "../../mcp/result";
import type { BuiltinHandler, BuiltinSpec, ToolAnnotations } from "../../types";
import { isSchemaMissing } from "../../registry/db";
import {
  DEFAULT_IMPORTANCE, DEFAULT_LIMIT, MAX_CONTENT, MAX_LIMIT, MAX_QUERY, MAX_TAG_LENGTH, MAX_TAGS, MAX_TITLE, MEMORY_KINDS,
  forgetMemory, memoryStats, readMemory, recall, remember, reviseMemory,
  type Memory, type MemoryKind, type RecallMode
} from "../../memory/store";

// ---------------------------------------------------------------------------------------------------------------------
// Annotations (§11): recall/read/stats read-only+idempotent; revise idempotent; forget destructive+idempotent; remember none.
// ---------------------------------------------------------------------------------------------------------------------
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPDATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DELETE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// ---------------------------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------------------------
const kindSchema = z.enum(MEMORY_KINDS).describe("One of note, decision, lesson, context, person, project.");
const tagsSchema = z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS).describe(`Up to ${MAX_TAGS} short tags (used for filtering and search).`);
const idSchema = z.uuid().describe("Memory id (uuid) as returned by remember or recall.");
const importanceSchema = z.number().int().min(1).max(5).describe("1 (trivia) … 5 (critical). Recent/important memories are listed first.");

export const rememberInput = z.object({
  content: z.string().min(1).max(MAX_CONTENT).describe("What to remember. The first line becomes the title unless `title` is given."),
  title: z.string().max(MAX_TITLE).optional().describe(`Short title (≤ ${MAX_TITLE} chars). Default: first line of the content.`),
  kind: kindSchema.default("note").optional(),
  tags: tagsSchema.optional(),
  importance: importanceSchema.default(DEFAULT_IMPORTANCE).optional()
});
export const recallInput = z.object({
  query: z.string().max(MAX_QUERY).optional().describe("Words to look for (every word must match; full-text search over title, content and tags). Omit to list the most recent and important memories."),
  kind: kindSchema.optional(),
  tag: z.string().min(1).max(MAX_TAG_LENGTH).optional().describe("Only memories carrying exactly this tag."),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).optional().describe(`Max results (1..${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`)
});
export const readMemoryInput = z.object({ id: idSchema });
export const reviseMemoryInput = z.object({
  id: idSchema,
  title: z.string().min(1).max(MAX_TITLE).optional(),
  content: z.string().min(1).max(MAX_CONTENT).optional(),
  kind: kindSchema.optional(),
  tags: tagsSchema.optional().describe("Replaces the whole tag list."),
  importance: importanceSchema.optional()
}).refine((v) => [v.title, v.content, v.kind, v.tags, v.importance].some((f) => f !== undefined), {
  message: "Provide at least one field to change: title, content, kind, tags or importance."
});
export const forgetMemoryInput = z.object({ id: idSchema });
export const memoryStatsInput = z.object({});

// ---------------------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------------------
const SNIPPET = 1_200;
function shortDate(iso: string): string { return iso.replace(/\.\d{3}Z$/, "Z"); }
function header(m: Memory): string {
  const tags = m.tags.length ? ` · tags: ${m.tags.join(", ")}` : "";
  return `[${m.kind}] ${m.title} — importance ${m.importance}${tags} · updated ${shortDate(m.updated_at)} · by ${m.created_by}`;
}
function indent(text: string, pad = "   "): string { return text.split(/\r?\n/).map((l) => `${pad}${l}`).join("\n"); }
function snippet(content: string): string {
  return content.length > SNIPPET ? `${content.slice(0, SNIPPET)}…\n(${content.length - SNIPPET} more chars; read_memory shows the full text)` : content;
}
function formatOne(m: Memory): string { return `${header(m)}\nid: ${m.id}\n\n${m.content}`; }
function formatList(rows: Memory[]): string {
  return rows.map((m, i) => `${i + 1}. ${header(m)}\n   id: ${m.id}\n${indent(snippet(m.content))}`).join("\n\n");
}
function modeLabel(mode: RecallMode): string {
  return mode === "fts" ? "full-text search" : mode === "like" ? "substring search (FTS5 index unavailable, LIKE fallback)" : "most recent and important";
}
function asJson(m: Memory): Record<string, unknown> { return { ...m }; }
function notFound(id: string): CallToolResult {
  return fail("not_found", `No memory with id ${id}.`, "recall lists memories with their ids; the id must be the full uuid.");
}

/** Wraps a handler: a missing memory schema (SchemaMissingError / `no such table`, via registry/db.ts isSchemaMissing) → db_not_migrated;
 *  anything else thrown → internal (tools never throw). */
function guarded(fn: BuiltinHandler): BuiltinHandler {
  return async (args, exec) => {
    try { return await fn(args, exec); }
    catch (e) {
      if (isSchemaMissing(e)) {
        return fail("db_not_migrated", "The memory tables are not migrated.", "Run `npm run db:migrate:remote` (or `npm run db:migrate:local` for wrangler dev) and retry.");
      }
      const message = e instanceof Error ? e.message : String(e);
      console.error("memory tool failed", message);
      return fail("internal", "The memory store failed unexpectedly.", undefined, { message: message.slice(0, 500) });
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------------
const rememberTool: BuiltinSpec = {
  name: "remember",
  title: "Remember",
  description: "Store a memory (note, decision, lesson, context, person or project) with optional title, tags and importance 1..5. The first line of the content becomes the title when none is given. Returns the new memory's id.",
  inputSchema: rememberInput,
  annotations: CREATE,
  handler: guarded(async (args, exec) => {
    const a = args as z.infer<typeof rememberInput>;
    const m = await remember(exec.scope.env.DB, { content: a.content, title: a.title, kind: a.kind, tags: a.tags, importance: a.importance }, exec.scope.principal.clientKey);
    const tags = m.tags.length ? `, tags: ${m.tags.join(", ")}` : "";
    return ok(`Remembered \`${m.title}\` (${m.kind}, importance ${m.importance}${tags}).\nid: ${m.id}`, asJson(m));
  })
};

const recallTool: BuiltinSpec = {
  name: "recall",
  title: "Recall memories",
  description: "Search memories by words (full-text, every word must match; falls back to substring search when FTS5 is unavailable) with optional kind/tag filters. Without a query, lists the most recent and important memories. Each hit includes its id for read_memory, revise_memory and forget_memory.",
  inputSchema: recallInput,
  annotations: READ_ONLY,
  handler: guarded(async (args, exec) => {
    const a = args as z.infer<typeof recallInput>;
    const r = await recall(exec.scope.env.DB, { query: a.query, kind: a.kind, tag: a.tag, limit: a.limit });
    const filters = [a.kind ? `kind=${a.kind}` : "", a.tag ? `tag=${a.tag}` : ""].filter(Boolean).join(" ");
    const what = r.query ? `"${r.query}"` : "recent memories";
    const head = `${r.rows.length} ${r.rows.length === 1 ? "memory" : "memories"} — ${what}${filters ? ` (${filters})` : ""} · ${modeLabel(r.mode)}`;
    const body = r.rows.length
      ? formatList(r.rows)
      : r.query
        ? "No memory matched. Try fewer or different words, drop the kind/tag filter, or call recall without a query to browse recent memories."
        : "No memories stored yet. Use remember to add one.";
    return ok(`${head}\n\n${body}`, { mode: r.mode, query: r.query, terms: r.terms, kind: a.kind ?? null, tag: a.tag ?? null, count: r.rows.length, memories: r.rows.map(asJson) });
  })
};

const readMemoryTool: BuiltinSpec = {
  name: "read_memory",
  title: "Read memory",
  description: "Return one memory in full (title, content, kind, tags, importance, timestamps) by its id. Fails with not_found when the id is unknown.",
  inputSchema: readMemoryInput,
  annotations: READ_ONLY,
  handler: guarded(async (args, exec) => {
    const a = args as z.infer<typeof readMemoryInput>;
    const m = await readMemory(exec.scope.env.DB, a.id);
    return m ? ok(formatOne(m), asJson(m)) : notFound(a.id);
  })
};

const reviseMemoryTool: BuiltinSpec = {
  name: "revise_memory",
  title: "Revise memory",
  description: "Update an existing memory in place: any of title, content, kind, tags (replaces the list) or importance. The id and created_at are kept; updated_at is bumped. Fails with not_found when the id is unknown.",
  inputSchema: reviseMemoryInput,
  annotations: UPDATE,
  handler: guarded(async (args, exec) => {
    const a = args as z.infer<typeof reviseMemoryInput>;
    const patch = { title: a.title, content: a.content, kind: a.kind as MemoryKind | undefined, tags: a.tags, importance: a.importance };
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== undefined);
    const m = await reviseMemory(exec.scope.env.DB, a.id, patch);
    if (!m) return notFound(a.id);
    return ok(`Revised \`${m.title}\` (${changed.join(", ")}).\nid: ${m.id}\nupdated_at: ${m.updated_at}`, { ...asJson(m), changed });
  })
};

const forgetMemoryTool: BuiltinSpec = {
  name: "forget_memory",
  title: "Forget memory",
  description: "Permanently delete one memory by id. Not reversible — confirm with the user first. Fails with not_found when the id is unknown.",
  inputSchema: forgetMemoryInput,
  annotations: DELETE,
  meta: { "anthropic/requiresUserInteraction": true },
  handler: guarded(async (args, exec) => {
    const a = args as z.infer<typeof forgetMemoryInput>;
    const before = await readMemory(exec.scope.env.DB, a.id);
    const deleted = await forgetMemory(exec.scope.env.DB, a.id);
    if (!deleted) return notFound(a.id);
    return ok(`Forgot \`${before?.title ?? a.id}\`.\nid: ${a.id}`, { id: a.id, forgotten: true, title: before?.title ?? null, kind: before?.kind ?? null });
  })
};

const memoryStatsTool: BuiltinSpec = {
  name: "memory_stats",
  title: "Memory stats",
  description: "Totals by kind, the ten most used tags, the latest update time and whether the FTS5 index is on (recall uses a LIKE fallback when it is off).",
  inputSchema: memoryStatsInput,
  annotations: READ_ONLY,
  handler: guarded(async (_args, exec) => {
    const s = await memoryStats(exec.scope.env.DB);
    const kinds = MEMORY_KINDS.map((k) => `${k} ${s.byKind[k]}`).join(" · ");
    const tags = s.topTags.length ? s.topTags.map((t) => `${t.tag} (${t.count})`).join(", ") : "none";
    const text = [
      `${s.total} ${s.total === 1 ? "memory" : "memories"} · fts ${s.fts}`,
      `by kind: ${kinds}`,
      `top tags: ${tags}`,
      `latest update: ${s.latestUpdatedAt ?? "never"}`
    ].join("\n");
    return ok(text, { total: s.total, byKind: s.byKind, topTags: s.topTags, latestUpdatedAt: s.latestUpdatedAt, fts: s.fts });
  })
};

/** The memory tools, imported by src/tools/builtin/index.ts [B] into BUILTINS. */
export const memoryTools: BuiltinSpec[] = [rememberTool, recallTool, readMemoryTool, reviseMemoryTool, forgetMemoryTool, memoryStatsTool];
