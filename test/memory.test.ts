// test/memory.test.ts [D] — §18 memory row: remember → recall (FTS hit; then DROP memories_fts → LIKE fallback still finds
// it, memory_stats.fts === "off") → read → revise → forget (not_found after) → stats.
//
// pool-workers gives every test FILE its own D1 (verified: a sibling file never sees this file's rows or the dropped
// table) but does NOT undo writes between tests inside a file — so this file is one ordered chain and the FTS drop
// comes last. Three layers: the store against env.DB, the builtin handlers with a fabricated ExecContext, and (once
// workstreams A+B land) the same chain through SELF.fetch("https://homcp.test/mcp"); the /mcp blocks self-skip while
// src/worker.ts is still the W0 503 stub.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  remember, recall, readMemory, reviseMemory, forgetMemory, memoryStats,
  defaultTitle, normalizeTags, queryTerms, toMatchExpression, isFtsBroken, resetFtsState, MEMORY_KINDS
} from "../src/memory/store";
import { memoryTools } from "../src/tools/builtin/memory";
import type { Env, ExecContext, Principal, RequestScope, ResolvedCatalog } from "../src/types";
import { BASE, callTool, errorOf, structuredOf, textOf, toolNames } from "./helpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const db = env.DB;

// ---- the /mcp lane is only exercised once the real worker (A) and BUILTINS (B) exist ----
const e2eReady = await SELF.fetch(`${BASE}/health`).then((r) => r.status !== 503, () => false);

// ---- builtin handlers with a fabricated ExecContext (what src/registry/dispatch.ts passes) ----
function fakeExec(clientKey = "token"): ExecContext {
  const url = new URL(`${BASE}/mcp`);
  const principal: Principal = { userId: "owner", via: "token", clientKey, scopes: [] };
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const scope: RequestScope = { env: env as unknown as Env, ctx, url, origin: url.origin, host: url.host, principal, hop: 0 };
  return { scope, catalog: {} as ResolvedCatalog, depth: 0 };
}
function tool(name: string) {
  const t = memoryTools.find((x) => x.name === name);
  if (!t) throw new Error(`no memory tool ${name}`);
  return t;
}
/** Validates through ~standard (defaults applied, like the dispatcher) and runs the handler. */
async function run(name: string, args: Record<string, unknown> = {}, exec: ExecContext = fakeExec()) {
  const t = tool(name);
  const parsed = await t.inputSchema["~standard"].validate(args);
  if (parsed.issues) throw new Error(`${name}: invalid arguments ${JSON.stringify(parsed.issues)}`);
  return t.handler(parsed.value as Record<string, unknown>, exec);
}
async function issuesOf(name: string, args: Record<string, unknown>) {
  const parsed = await tool(name).inputSchema["~standard"].validate(args);
  return parsed.issues ?? [];
}

// =====================================================================================================================
describe("memory store — helpers", () => {
  it("defaultTitle takes the first non-empty line, collapsed and cut at 160", () => {
    expect(defaultTitle("\n\n  Deploy   notes  \nsecond")).toBe("Deploy notes");
    expect(defaultTitle("x".repeat(500))).toHaveLength(160);
    expect(defaultTitle("   ")).toBe("Untitled");
  });
  it("normalizeTags trims, dedupes, caps at 10 and 64 chars", () => {
    expect(normalizeTags([" ops ", "ops", "", "deploy", "a".repeat(80)])).toEqual(["ops", "deploy", "a".repeat(64)]);
    expect(normalizeTags(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
    expect(normalizeTags(undefined)).toEqual([]);
  });
  it("queryTerms drops pure punctuation; toMatchExpression quotes every term and doubles embedded quotes", () => {
    expect(queryTerms('  deploy   --- wrangler!  say"hi" ')).toEqual(["deploy", "wrangler!", 'say"hi"']);
    expect(queryTerms("--- !!! \"\"")).toEqual([]);
    expect(toMatchExpression(["deploy", 'say"hi"'])).toBe('"deploy" "say""hi"""');
  });
});

// =====================================================================================================================
describe("memory store — direct D1", () => {
  const ids: Record<string, string> = {};

  it("remember: uuid id, title from the first line, tags + tags_text, defaults, created_by = actor", async () => {
    const a = await remember(db, { content: "Deploy the worker with wrangler\nthen run the migrations", tags: ["ops", "deploy", "ops"] }, "token");
    expect(a.id).toMatch(UUID_RE);
    expect(a.title).toBe("Deploy the worker with wrangler");
    expect(a.kind).toBe("note");
    expect(a.importance).toBe(3);
    expect(a.tags).toEqual(["ops", "deploy"]);
    expect(a.created_by).toBe("token");
    expect(a.created_at).toBe(a.updated_at);
    ids.a = a.id;
    const raw = await db.prepare("SELECT tags, tags_text FROM memories WHERE id = ?1").bind(a.id).first<{ tags: string; tags_text: string }>();
    expect(raw).toEqual({ tags: JSON.stringify(["ops", "deploy"]), tags_text: "ops deploy" });

    const b = await remember(db, { content: "wrangler secret put MCP_API_TOKEN stores the static bearer", title: "  Static   token  ", kind: "lesson", importance: 5, tags: ["ops"] }, "claude-code");
    expect(b.title).toBe("Static token");
    expect(b.kind).toBe("lesson");
    expect(b.importance).toBe(5);
    expect(b.created_by).toBe("claude-code");
    ids.b = b.id;

    const c = await remember(db, { content: 'Nat said "hello" in the standup', kind: "person", importance: 1 }, "token");
    ids.c = c.id;
  });

  it("recall: FTS5 MATCH ranked by bm25, every term must match, kind/tag filters, limit", async () => {
    const one = await recall(db, { query: "wrangler" });
    expect(one.mode).toBe("fts");
    expect(one.rows.map((m) => m.id).sort()).toEqual([ids.a, ids.b].sort());

    const both = await recall(db, { query: "wrangler deploy" });
    expect(both.mode).toBe("fts");
    expect(both.rows.map((m) => m.id)).toEqual([ids.a]);

    expect((await recall(db, { query: "wrangler", kind: "lesson" })).rows.map((m) => m.id)).toEqual([ids.b]);
    expect((await recall(db, { query: "wrangler", tag: "deploy" })).rows.map((m) => m.id)).toEqual([ids.a]);
    expect((await recall(db, { query: "wrangler", tag: "ops" })).rows).toHaveLength(2);
    expect((await recall(db, { query: "wrangler", limit: 1 })).rows).toHaveLength(1);
    expect((await recall(db, { query: "nothing-like-this-anywhere" })).rows).toEqual([]);

    const quoted = await recall(db, { query: 'said "hello"' });                    // embedded quotes never become FTS syntax
    expect(quoted.mode).toBe("fts");
    expect(quoted.rows.map((m) => m.id)).toEqual([ids.c]);
    expect(isFtsBroken()).toBe(false);
  });

  it("recall: empty or punctuation-only query → recent mode ordered by importance DESC, updated_at DESC", async () => {
    const recent = await recall(db, {});
    expect(recent.mode).toBe("recent");
    expect(recent.rows.map((m) => m.id)).toEqual([ids.b, ids.a, ids.c]);         // importance 5, 3, 1
    expect((await recall(db, { query: "--- !!!" })).mode).toBe("recent");
    expect((await recall(db, { query: "   ", kind: "person" })).rows.map((m) => m.id)).toEqual([ids.c]);
    expect((await recall(db, { limit: 2 })).rows).toHaveLength(2);
  });

  it("readMemory returns the row or null", async () => {
    const m = await readMemory(db, ids.a);
    expect(m?.title).toBe("Deploy the worker with wrangler");
    expect(m?.tags).toEqual(["ops", "deploy"]);
    expect(await readMemory(db, crypto.randomUUID())).toBeNull();
  });

  it("reviseMemory: COALESCE patch keeps untouched fields, bumps updated_at, re-indexes FTS; unknown id → null", async () => {
    const before = (await readMemory(db, ids.a))!;
    await new Promise((r) => setTimeout(r, 5));
    const m = await reviseMemory(db, ids.a, { content: "Ship it with the deploy script instead", tags: ["ops", "release"] });
    expect(m).not.toBeNull();
    expect(m!.id).toBe(ids.a);
    expect(m!.title).toBe(before.title);                                          // untouched
    expect(m!.kind).toBe(before.kind);
    expect(m!.importance).toBe(before.importance);
    expect(m!.content).toBe("Ship it with the deploy script instead");
    expect(m!.tags).toEqual(["ops", "release"]);
    expect(m!.created_at).toBe(before.created_at);
    expect(m!.updated_at > before.updated_at).toBe(true);

    expect((await recall(db, { query: "migrations" })).rows).toEqual([]);                        // old content gone from the index
    expect((await recall(db, { query: "wrangler" })).rows.map((x) => x.id).sort()).toEqual([ids.a, ids.b].sort());   // title still indexed
    expect((await recall(db, { query: "script" })).rows.map((x) => x.id)).toEqual([ids.a]);     // new content indexed
    expect((await recall(db, { query: "ship", tag: "release" })).rows.map((x) => x.id)).toEqual([ids.a]);

    const t = await reviseMemory(db, ids.a, { title: "Release notes", importance: 4 });
    expect(t!.title).toBe("Release notes");
    expect(t!.importance).toBe(4);
    expect(t!.content).toBe("Ship it with the deploy script instead");
    expect(await reviseMemory(db, crypto.randomUUID(), { title: "x" })).toBeNull();
  });

  it("forgetMemory: true once, false after; the row and its FTS entry are gone", async () => {
    expect(await forgetMemory(db, ids.c)).toBe(true);
    expect(await forgetMemory(db, ids.c)).toBe(false);
    expect(await readMemory(db, ids.c)).toBeNull();
    expect((await recall(db, { query: "standup" })).rows).toEqual([]);
  });

  it("memoryStats: totals by kind, top tags, latest update, fts on", async () => {
    const s = await memoryStats(db);
    expect(s.total).toBe(2);
    expect(s.byKind).toEqual({ note: 1, decision: 0, lesson: 1, context: 0, person: 0, project: 0 });
    expect(s.topTags).toEqual([{ tag: "ops", count: 2 }, { tag: "release", count: 1 }]);
    expect(s.latestUpdatedAt).toBe((await readMemory(db, ids.a))!.updated_at);
    expect(s.fts).toBe("on");
    expect(Object.keys(s.byKind)).toEqual([...MEMORY_KINDS]);
  });
});

// =====================================================================================================================
describe("memory tools — builtin specs", () => {
  it("exports the six §11 tools with the right annotations, meta and schemas", () => {
    expect(memoryTools.map((t) => t.name)).toEqual(["remember", "recall", "read_memory", "revise_memory", "forget_memory", "memory_stats"]);
    const hints = (n: string) => tool(n).annotations;
    expect(hints("remember")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(hints("recall")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(hints("read_memory")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(hints("revise_memory")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(hints("forget_memory")).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(hints("memory_stats")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool("forget_memory").meta).toEqual({ "anthropic/requiresUserInteraction": true });
    for (const t of memoryTools) {
      expect(t.inputSchema).toBeInstanceOf(z.ZodObject);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description.length).toBeLessThanOrEqual(400);
      expect(t.protected).toBeFalsy();
      expect(t.hiddenByDefault).toBeFalsy();
    }
  });

  it("JSON Schema keeps defaulted fields optional (zod 4 output-mode trap) and defaults still apply", async () => {
    const recallJson = z.toJSONSchema(tool("recall").inputSchema) as { required?: string[]; properties: Record<string, { default?: unknown }> };
    expect(recallJson.required ?? []).toEqual([]);
    expect(recallJson.properties.limit.default).toBe(10);
    const rememberJson = z.toJSONSchema(tool("remember").inputSchema) as { required?: string[] };
    expect(rememberJson.required).toEqual(["content"]);
    const parsed = await tool("remember").inputSchema["~standard"].validate({ content: "x" });
    expect(parsed.issues).toBeUndefined();
    expect((parsed as { value: Record<string, unknown> }).value).toMatchObject({ content: "x", kind: "note", importance: 3 });
    expect(await issuesOf("revise_memory", { id: crypto.randomUUID() })).not.toHaveLength(0);     // needs ≥ 1 field
    expect(await issuesOf("read_memory", { id: "not-a-uuid" })).not.toHaveLength(0);
    expect(await issuesOf("remember", { content: "x", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).not.toHaveLength(0);
  });
});

// =====================================================================================================================
describe("memory tools — handlers (fabricated ExecContext)", () => {
  let id = "";

  it("remember returns the id + summary; created_by is the principal's clientKey", async () => {
    const r = await run("remember", { content: "Compose steps run sequentially\nwith arg mapping", tags: ["design", "compose"], kind: "decision", importance: 4 }, fakeExec("claude"));
    expect(r.isError).toBeFalsy();
    const s = structuredOf<{ id: string; title: string; kind: string; tags: string[]; importance: number; created_by: string }>(r);
    expect(s.id).toMatch(UUID_RE);
    expect(s).toMatchObject({ title: "Compose steps run sequentially", kind: "decision", tags: ["design", "compose"], importance: 4, created_by: "claude" });
    expect(textOf(r)).toContain("Remembered `Compose steps run sequentially`");
    expect(textOf(r)).toContain(`id: ${s.id}`);
    id = s.id;
  });

  it("recall reports mode + memories; filters and the empty-query browse work", async () => {
    const r = await run("recall", { query: "compose sequentially" });
    const s = structuredOf<{ mode: string; count: number; memories: { id: string; content: string }[] }>(r);
    expect(s.mode).toBe("fts");
    expect(s.count).toBe(1);
    expect(s.memories[0].id).toBe(id);
    expect(s.memories[0].content).toContain("arg mapping");
    expect(textOf(r)).toContain("full-text search");
    expect(textOf(r)).toContain(`id: ${id}`);

    const browse = structuredOf<{ mode: string; count: number }>(await run("recall", {}));
    expect(browse.mode).toBe("recent");
    expect(browse.count).toBe(3);
    expect(structuredOf<{ count: number }>(await run("recall", { query: "compose", tag: "design" })).count).toBe(1);
    expect(structuredOf<{ count: number }>(await run("recall", { query: "compose", kind: "lesson" })).count).toBe(0);
    expect(textOf(await run("recall", { query: "zzz-nothing" }))).toContain("No memory matched");
  });

  it("read_memory returns the full memory; not_found for an unknown id", async () => {
    const r = await run("read_memory", { id });
    expect(structuredOf<{ id: string }>(r).id).toBe(id);
    expect(textOf(r)).toContain("with arg mapping");
    const missing = await run("read_memory", { id: crypto.randomUUID() });
    expect(missing.isError).toBe(true);
    expect(errorOf(missing)?.code).toBe("not_found");
  });

  it("revise_memory patches in place and lists what changed; not_found for an unknown id", async () => {
    const r = await run("revise_memory", { id, importance: 5, tags: ["design"] });
    expect(r.isError).toBeFalsy();
    const s = structuredOf<{ id: string; importance: number; tags: string[]; title: string; changed: string[] }>(r);
    expect(s).toMatchObject({ id, importance: 5, tags: ["design"], title: "Compose steps run sequentially", changed: ["tags", "importance"] });
    expect(errorOf(await run("revise_memory", { id: crypto.randomUUID(), title: "x" }))?.code).toBe("not_found");
  });

  it("forget_memory deletes once, then not_found", async () => {
    const r = await run("forget_memory", { id });
    expect(structuredOf<{ id: string; forgotten: boolean; title: string }>(r)).toMatchObject({ id, forgotten: true, title: "Compose steps run sequentially" });
    const again = await run("forget_memory", { id });
    expect(again.isError).toBe(true);
    expect(errorOf(again)?.code).toBe("not_found");
    expect(errorOf(await run("read_memory", { id }))?.code).toBe("not_found");
  });

  it("memory_stats", async () => {
    const r = await run("memory_stats");
    const s = structuredOf<{ total: number; fts: string; byKind: Record<string, number>; topTags: { tag: string; count: number }[] }>(r);
    expect(s.total).toBe(2);
    expect(s.fts).toBe("on");
    expect(s.byKind.lesson).toBe(1);
    expect(s.topTags[0]).toEqual({ tag: "ops", count: 2 });
    expect(textOf(r)).toContain("2 memories · fts on");
  });

  it("db_not_migrated when the memories table is gone (simulated via a renamed table)", async () => {
    await db.exec("ALTER TABLE memories RENAME TO memories_backup");
    try {
      resetFtsState();
      for (const [name, args] of [
        ["remember", { content: "x" }], ["recall", { query: "x" }], ["recall", {}], ["read_memory", { id: crypto.randomUUID() }],
        ["revise_memory", { id: crypto.randomUUID(), title: "x" }], ["forget_memory", { id: crypto.randomUUID() }], ["memory_stats", {}]
      ] as [string, Record<string, unknown>][]) {
        const r = await run(name, args);
        expect(r.isError, name).toBe(true);
        expect(errorOf(r)?.code, name).toBe("db_not_migrated");
        expect(textOf(r), name).toContain("db:migrate");
      }
    } finally {
      await db.exec("ALTER TABLE memories_backup RENAME TO memories");
      resetFtsState();
    }
    expect((await recall(db, { query: "wrangler" })).mode).toBe("fts");
  });
});

// =====================================================================================================================
describe.skipIf(!e2eReady)("memory tools over /mcp (§18 chain; runs once workstreams A+B land)", () => {
  let id = "";
  it("tools/list shows the six memory tools", async () => {
    const names = await toolNames();
    for (const n of ["remember", "recall", "read_memory", "revise_memory", "forget_memory", "memory_stats"]) expect(names).toContain(n);
  });
  it("remember → recall (FTS hit) → read → revise → forget (not_found after) → stats", async () => {
    const r = await callTool("remember", { content: "Edge deploy needs `wrangler d1 migrations apply DB --remote` after `wrangler deploy`", tags: ["ops"], kind: "lesson" });
    expect(r.isError).toBeFalsy();
    id = structuredOf<{ id: string; created_by: string }>(r).id;
    expect(id).toMatch(UUID_RE);
    expect(structuredOf<{ created_by: string }>(r).created_by).toBe("token");

    const hit = structuredOf<{ mode: string; memories: { id: string }[] }>(await callTool("recall", { query: "migrations remote" }));
    expect(hit.mode).toBe("fts");
    expect(hit.memories.map((m) => m.id)).toContain(id);

    expect(structuredOf<{ id: string }>(await callTool("read_memory", { id })).id).toBe(id);
    expect(structuredOf<{ importance: number }>(await callTool("revise_memory", { id, importance: 5 })).importance).toBe(5);
    expect(structuredOf<{ forgotten: boolean }>(await callTool("forget_memory", { id })).forgotten).toBe(true);
    expect(errorOf(await callTool("forget_memory", { id }))?.code).toBe("not_found");
    expect(errorOf(await callTool("read_memory", { id }))?.code).toBe("not_found");
    expect(structuredOf<{ fts: string }>(await callTool("memory_stats")).fts).toBe("on");
  });
});

// =====================================================================================================================
// LAST: FTS5 gone. Drops the virtual table AND its three triggers — exactly what a D1 without FTS5 looks like after
// 0002_memory.sql fails at CREATE VIRTUAL TABLE (the triggers after it are never created), so writes keep working.
describe("LIKE fallback when memories_fts is gone", () => {
  let id = "";
  it("recall keeps finding memories in like mode, memoises the failure, and memory_stats reports fts off", async () => {
    const m = await remember(db, { content: "Fallback probe: searching without FTS still works", tags: ["fallback", "ops"], kind: "context" }, "token");
    id = m.id;
    expect((await recall(db, { query: "fallback searching" })).mode).toBe("fts");
    await db.batch([
      db.prepare("DROP TRIGGER IF EXISTS memories_ai"), db.prepare("DROP TRIGGER IF EXISTS memories_au"),
      db.prepare("DROP TRIGGER IF EXISTS memories_ad"), db.prepare("DROP TABLE IF EXISTS memories_fts")
    ]);
    expect(isFtsBroken()).toBe(false);
    const r = await recall(db, { query: "fallback searching" });
    expect(r.mode).toBe("like");
    expect(r.rows.map((x) => x.id)).toEqual([id]);
    expect(isFtsBroken()).toBe(true);
    expect((await recall(db, { query: "FALLBACK", tag: "ops" })).rows.map((x) => x.id)).toEqual([id]);         // case-insensitive + tag filter
    expect((await recall(db, { query: "fallback", kind: "note" })).rows).toEqual([]);
    expect((await recall(db, { query: "100%_literal" })).rows).toEqual([]);                                     // LIKE wildcards escaped
    expect((await recall(db, {})).mode).toBe("recent");
    const s = await memoryStats(db);
    expect(s.fts).toBe("off");
    expect(s.total).toBe(3);
  });
  it("the tools keep working without the index: remember/recall/revise/forget, stats fts off", async () => {
    const r = await run("remember", { content: "Second fallback memory about wrangler", tags: ["fallback"] });
    expect(r.isError).toBeFalsy();
    const second = structuredOf<{ id: string }>(r).id;
    const rec = await run("recall", { query: "fallback" });
    const s = structuredOf<{ mode: string; memories: { id: string }[] }>(rec);
    expect(s.mode).toBe("like");
    expect(s.memories.map((x) => x.id).sort()).toEqual([id, second].sort());
    expect(textOf(rec)).toContain("LIKE fallback");
    expect(structuredOf<{ content: string }>(await run("revise_memory", { id: second, content: "edited without fts" })).content).toBe("edited without fts");
    expect(structuredOf<{ mode: string; memories: unknown[] }>(await run("recall", { query: "edited" })).memories).toHaveLength(1);
    expect(structuredOf<{ forgotten: boolean }>(await run("forget_memory", { id: second })).forgotten).toBe(true);
    expect(structuredOf<{ fts: string; total: number }>(await run("memory_stats")).fts).toBe("off");
    expect(textOf(await run("memory_stats"))).toContain("fts off");
  });
  it.skipIf(!e2eReady)("over /mcp: recall still finds it and memory_stats.fts === \"off\"", async () => {
    const hit = structuredOf<{ mode: string; memories: { id: string }[] }>(await callTool("recall", { query: "fallback probe" }));
    expect(hit.mode).toBe("like");
    expect(hit.memories.map((m) => m.id)).toContain(id);
    expect(structuredOf<{ fts: string }>(await callTool("memory_stats")).fts).toBe("off");
  });
});
