// test/names.test.ts [B] — §18 names row: TOOL_NAME_RE, nameBudget, validateToolName, validateInputSchema, validateUpstreamName.
// Pure: builds a catalog through resolveCatalog with synthetic built-ins (no worker, no D1).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emptySnapshot } from "../src/registry/db";
import { MAX_SCHEMA_DEPTH, TOOL_NAME_RE, nameBudget, schemaDepth, validateInputSchema, validateToolName, validateUpstreamName } from "../src/registry/names";
import { resolveCatalog } from "../src/registry/resolve";
import type { BuiltinSpec, Identity, Principal, ResolvedCatalog, Snapshot, ToolDefRow } from "../src/types";
import { DEFAULT_HIDDEN_TOOLS, DEFAULT_VISIBLE_TOOLS } from "./helpers";

const PRINCIPAL: Principal = { userId: "owner", via: "token", clientKey: "token", scopes: [] };
const IDENTITY: Identity = { name: "thor-memory", instructions: "x", source: "settings" };

function builtin(name: string, hidden = false): BuiltinSpec {
  return { name, title: name, description: name, inputSchema: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, hiddenByDefault: hidden, handler: async () => ({ content: [] }) };
}
const BUILTINS = [...DEFAULT_VISIBLE_TOOLS.map((n) => builtin(n)), ...DEFAULT_HIDDEN_TOOLS.map((n) => builtin(n, true))];

function def(name: string): ToolDefRow {
  return { name, kind: "template", title: name, description: name, input_schema: '{"type":"object","properties":{}}', spec: '{"text":"hi"}', annotations: "{}", created_by: "t", created_at: "", updated_at: "", version: 1 };
}
function catalogWith(defs: ToolDefRow[] = [], identity: Identity = IDENTITY): ResolvedCatalog {
  const snap: Snapshot = { ...emptySnapshot(), schemaMissing: false, catalogVersion: 1, defs };
  return resolveCatalog(BUILTINS, snap, PRINCIPAL, identity);
}

describe("TOOL_NAME_RE", () => {
  it("rejects dots, leading digits and 65 chars; accepts a-b_c and 64 chars", () => {
    expect(TOOL_NAME_RE.test("a.b")).toBe(false);
    expect(TOOL_NAME_RE.test("1abc")).toBe(false);
    expect(TOOL_NAME_RE.test("a".repeat(65))).toBe(false);
    expect(TOOL_NAME_RE.test("")).toBe(false);
    expect(TOOL_NAME_RE.test("a b")).toBe(false);
    expect(TOOL_NAME_RE.test("a-b_c")).toBe(true);
    expect(TOOL_NAME_RE.test("a".repeat(64))).toBe(true);
    expect(TOOL_NAME_RE.test("Standup2")).toBe(true);
  });
});

describe("nameBudget", () => {
  it("is min(64, 121 - len(identity))", () => {
    expect(nameBudget("thor-memory")).toBe(64);
    expect(nameBudget("homcp")).toBe(64);
    expect(nameBudget("a".repeat(57))).toBe(64);
    expect(nameBudget("a".repeat(60))).toBe(61);
  });
});

describe("validateToolName", () => {
  const catalog = catalogWith([def("standup")]);
  it("accepts a fresh valid name", () => {
    expect(validateToolName("weekly_report", catalog)).toBeNull();
  });
  it("rejects invalid charset with invalid_name", () => {
    expect(validateToolName("a.b", catalog)?.code).toBe("invalid_name");
    expect(validateToolName("9lives", catalog)?.code).toBe("invalid_name");
  });
  it("rejects reserved names: mcp__ prefix and mcp/tools/call/list", () => {
    expect(validateToolName("mcp__x", catalog)?.code).toBe("invalid_name");
    for (const r of ["mcp", "tools", "call", "list"]) expect(validateToolName(r, catalog)?.code).toBe("invalid_name");
  });
  it("rejects a built-in collision even with replace:true", () => {
    const err = validateToolName("list_tools", catalog, { replace: true });
    expect(err?.code).toBe("name_taken");
    expect(err?.message).toContain("built-in");
    expect(validateToolName("remember", catalog)?.code).toBe("name_taken");
  });
  it("replace semantics: a defined name is taken without replace and free with replace", () => {
    const err = validateToolName("standup", catalog);
    expect(err?.code).toBe("name_taken");
    expect(err?.hint).toContain("replace:true");
    expect(validateToolName("standup", catalog, { replace: true })).toBeNull();
  });
  it("enforces the identity-dependent budget with name_too_long", () => {
    const longIdentity = catalogWith([], { ...IDENTITY, name: "a".repeat(60) });
    expect(validateToolName("b".repeat(61), longIdentity)).toBeNull();
    const err = validateToolName("b".repeat(62), longIdentity);
    expect(err?.code).toBe("name_too_long");
    expect(err?.message).toContain("budget");
  });
});

describe("validateInputSchema", () => {
  const good = { type: "object", properties: { project: { type: "string", description: "x" }, days: { type: "integer", minimum: 1 } }, required: ["project"], additionalProperties: false };
  it("accepts and compiles a good schema", () => {
    expect(validateInputSchema(good)).toBeNull();
    expect(validateInputSchema({ type: "object" })).toBeNull();
  });
  it("rejects a non-object root", () => {
    expect(validateInputSchema({ type: "string" })?.code).toBe("schema_invalid");
    expect(validateInputSchema("nope")?.code).toBe("schema_invalid");
    expect(validateInputSchema(null)?.code).toBe("schema_invalid");
    expect(validateInputSchema([])?.code).toBe("schema_invalid");
  });
  it("rejects root combinators and $ref", () => {
    expect(validateInputSchema({ type: "object", anyOf: [{ type: "object" }] })?.message).toContain("anyOf");
    expect(validateInputSchema({ type: "object", oneOf: [] })?.code).toBe("schema_invalid");
    expect(validateInputSchema({ type: "object", allOf: [] })?.code).toBe("schema_invalid");
    expect(validateInputSchema({ type: "object", $ref: "#/x" })?.code).toBe("schema_invalid");
  });
  it("rejects bad property names", () => {
    const err = validateInputSchema({ type: "object", properties: { "bad name!": { type: "string" } } });
    expect(err?.code).toBe("schema_invalid");
    expect(err?.message).toContain("bad name!");
    expect(validateInputSchema({ type: "object", properties: { ["a".repeat(65)]: { type: "string" } } })?.code).toBe("schema_invalid");
    expect(validateInputSchema({ type: "object", properties: { "ok.name-1_": { type: "string" } } })).toBeNull();
  });
  it("rejects a 9 KB schema", () => {
    const err = validateInputSchema({ type: "object", properties: { a: { type: "string", description: "x".repeat(9 * 1024) } } });
    expect(err?.code).toBe("schema_invalid");
    expect(err?.message).toContain("bytes");
  });
  it("rejects depth 5 and accepts depth 4", () => {
    const nest = (levels: number): Record<string, unknown> => (levels === 1 ? { type: "string" } : { type: "object", properties: { child: nest(levels - 1) } });
    expect(schemaDepth(nest(4))).toBe(4);
    expect(validateInputSchema(nest(MAX_SCHEMA_DEPTH))).toBeNull();
    const err = validateInputSchema(nest(5));
    expect(err?.code).toBe("schema_invalid");
    expect(err?.message).toContain("deep");
    expect(validateInputSchema({ type: "object", properties: { list: { type: "array", items: { type: "object", properties: { deep: { type: "object", properties: { x: { type: "string" } } } } } } } })?.code).toBe("schema_invalid");
  });
});

describe("validateUpstreamName", () => {
  it("accepts lowercase names and rejects the rest", () => {
    expect(validateUpstreamName("self")).toBeNull();
    expect(validateUpstreamName("my-memory_2")).toBeNull();
    expect(validateUpstreamName("Self")).toMatch(/not a valid/);
    expect(validateUpstreamName("1a")).toMatch(/not a valid/);
    expect(validateUpstreamName("a".repeat(33))).toMatch(/not a valid/);
    expect(validateUpstreamName("")).toMatch(/not a valid/);
  });
});
