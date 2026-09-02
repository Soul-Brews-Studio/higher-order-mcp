// test/registry.test.ts [B] — §18 registry row, end to end through SELF.fetch("https://homcp.test/mcp") with the static
// token principal and an oauthDance principal. pool-workers isolates storage per test (beforeAll state per describe block).
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOL_NAME_RE } from "../src/registry/names";
import { BUILTINS, HIDDEN_BY_DEFAULT, PROTECTED } from "../src/tools/builtin";
import { DEFAULT_HIDDEN_TOOLS, DEFAULT_VISIBLE_TOOLS, TEST_IDENTITY, callTool, callToolRaw, errorOf, oauthDance, structuredOf, textOf, toolNames, toolsList } from "./helpers";

const STANDUP = {
  name: "standup", kind: "template", description: "Standup template for a project",
  input_schema: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false },
  spec: { text: "Standup for {{input.project}}: yesterday / today / blockers" }
};
/** pool-workers 0.22.0 does not roll D1 back between tests here, so every test starts from a clean registry. */
async function resetRegistry() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tool_overrides"),
    env.DB.prepare("DELETE FROM tool_defs"),
    env.DB.prepare("DELETE FROM upstreams"),
    env.DB.prepare("DELETE FROM registry_events"),
    env.DB.prepare("DELETE FROM settings WHERE key LIKE 'identity_%'"),
    env.DB.prepare("UPDATE settings SET value='12' WHERE key='promoted_budget'")
  ]);
}
beforeEach(resetRegistry);

/** Hidden built-ins (override_tool, remove_tool, …) are disable()d for direct tools/call — the SDK answers "Tool X disabled" — so they are reached through call_tool. */
async function hidden(name: string, args: Record<string, unknown> = {}, token?: string | null) {
  return callTool("call_tool", { name, arguments: args }, token);
}

async function define(overrides: Record<string, unknown> = {}, token?: string | null) {
  const r = await callTool("define_tool", { ...STANDUP, ...overrides }, token);
  expect(errorOf(r), textOf(r)).toBeUndefined();
  return r;
}
async function catalogVersion(token?: string | null): Promise<number> {
  return structuredOf<{ catalogVersion: number }>(await callTool("list_tools", {}, token)).catalogVersion;
}
function stateOf(list: { tools: { name: string; enabled: boolean; promoted: boolean; visible: boolean; decidedBy: { enabled: string; promoted: string } }[] }, name: string) {
  return list.tools.find((t) => t.name === name);
}
async function listState(name: string, token?: string | null) {
  return stateOf(structuredOf<{ tools: { name: string; enabled: boolean; promoted: boolean; visible: boolean; decidedBy: { enabled: string; promoted: string } }[] }>(await callTool("list_tools", {}, token)), name);
}

describe("BUILTINS invariants (§11)", () => {
  it("has 22 unique, well-formed tools split 15 listed / 7 hidden, 6 protected", () => {
    expect(BUILTINS).toHaveLength(22);
    const names = BUILTINS.map((b) => b.name);
    expect(new Set(names).size).toBe(22);
    expect(names.filter((n) => !HIDDEN_BY_DEFAULT.has(n)).sort()).toEqual(DEFAULT_VISIBLE_TOOLS);
    expect(names.filter((n) => HIDDEN_BY_DEFAULT.has(n)).sort()).toEqual(DEFAULT_HIDDEN_TOOLS);
    expect([...PROTECTED].sort()).toEqual(["call_tool", "demote_tool", "describe_tool", "list_tools", "promote_tool", "toggle_tool"]);
    for (const b of BUILTINS) {
      expect(b.name).toMatch(TOOL_NAME_RE);
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.description.length, `${b.name} description`).toBeLessThanOrEqual(400);
      expect(b.inputSchema).toBeInstanceOf(z.ZodObject);
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) expect(typeof b.annotations[hint], `${b.name}.${hint}`).toBe("boolean");
      expect(b.protected).toBe(PROTECTED.has(b.name));
      expect(b.hiddenByDefault).toBe(HIDDEN_BY_DEFAULT.has(b.name));
    }
    for (const n of ["list_tools", "describe_tool", "call_tool"]) expect(BUILTINS.find((b) => b.name === n)?.meta?.["anthropic/alwaysLoad"]).toBe(true);
    for (const n of ["remove_tool", "remove_upstream", "forget_memory"]) expect(BUILTINS.find((b) => b.name === n)?.meta?.["anthropic/requiresUserInteraction"]).toBe(true);
    for (const n of ["remove_tool", "remove_upstream", "forget_memory"]) expect(BUILTINS.find((b) => b.name === n)?.annotations.destructiveHint).toBe(true);
  });
  it("tools/list on a fresh database shows exactly the 15 default names", async () => {
    expect(await toolNames()).toEqual(DEFAULT_VISIBLE_TOOLS);
  });
});

describe("define → call → promote → demote (template)", () => {
  it("defines a hidden tool that call_tool can run while direct tools/call reports it disabled", async () => {
    const r = await define();
    expect(textOf(r)).toContain("Defined `standup` (template)");
    expect(textOf(r)).toContain("Not listed until promote_tool");
    expect(textOf(r)).toContain("Clients cache the tool list");
    expect(structuredOf(r)).toMatchObject({ name: "standup", kind: "template", visible: false, claudeCodeName: `mcp__${TEST_IDENTITY}__standup`, warnings: [] });
    expect(await toolNames()).not.toContain("standup");

    const called = await callTool("call_tool", { name: "standup", arguments: { project: "homcp" } });
    expect(errorOf(called)).toBeUndefined();
    expect(textOf(called)).toContain("Standup for homcp");

    const direct = await callToolRaw("standup", { project: "homcp" });
    expect(direct.error?.message).toContain("disabled");

    const listed = await listState("standup");
    expect(listed).toMatchObject({ enabled: true, promoted: false, visible: false, decidedBy: { enabled: "builtin", promoted: "builtin" } });
    const described = structuredOf<{ kind: string; spec: { text: string }; inputSchema: { required?: string[] }; claudeCodeNameLength: number; version: number }>(await callTool("describe_tool", { name: "standup" }));
    expect(described.kind).toBe("template");
    expect(described.spec.text).toContain("{{input.project}}");
    expect(described.inputSchema.required).toEqual(["project"]);
    expect(described.version).toBe(1);
    expect(described.claudeCodeNameLength).toBe(`mcp__${TEST_IDENTITY}__standup`.length);
  });
  it("promote lists it, demote hides it again, call_tool keeps working throughout", async () => {
    await define();
    const p = await callTool("promote_tool", { name: "standup" });
    expect(errorOf(p)).toBeUndefined();
    expect(textOf(p)).toContain("Promoted `standup` (visible 1 of budget 12)");
    expect(await toolNames()).toContain("standup");
    const entry = (await toolsList()).find((t) => t.name === "standup")!;
    expect(entry.description).toBe("Standup template for a project");
    expect(entry.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    const direct = await callToolRaw("standup", { project: "x" });
    expect(direct.error).toBeUndefined();
    expect(textOf(direct.result!)).toContain("Standup for x");

    const d = await callTool("demote_tool", { name: "standup" });
    expect(errorOf(d)).toBeUndefined();
    expect(await toolNames()).not.toContain("standup");
    expect(textOf(await callTool("call_tool", { name: "standup", arguments: { project: "again" } }))).toContain("Standup for again");
  });
  it("validates arguments through the definition's schema", async () => {
    await define();
    const r = await callTool("call_tool", { name: "standup", arguments: {} });
    expect(errorOf(r)?.code).toBe("invalid_arguments");
    expect(errorOf(r)?.hint).toContain("describe_tool");
  });
  it("replace:true updates in place (version 2) and keeps the promoted state", async () => {
    await define();
    await callTool("promote_tool", { name: "standup" });
    const r = await define({ replace: true, spec: { text: "v2 {{input.project}}" }, title: "Standup v2" });
    expect(textOf(r)).toContain("Replaced `standup`");
    expect(structuredOf(r)).toMatchObject({ visible: true, version: 2 });
    expect((await toolsList()).find((t) => t.name === "standup")?.title).toBe("Standup v2");
    expect(textOf(await callTool("call_tool", { name: "standup", arguments: { project: "p" } }))).toContain("v2 p");
  });
});

describe("define_tool refusals", () => {
  it("name_taken for built-ins (even with replace), invalid_name, schema_invalid, spec_invalid, name_taken without replace", async () => {
    expect(errorOf(await callTool("define_tool", { ...STANDUP, name: "remember", replace: true }))?.code).toBe("name_taken");
    expect(errorOf(await callTool("define_tool", { ...STANDUP, name: "my.tool" }))?.code).toBe("invalid_name");
    expect(errorOf(await callTool("define_tool", { ...STANDUP, name: "mcp__x" }))?.code).toBe("invalid_name");
    expect(errorOf(await callTool("define_tool", { ...STANDUP, input_schema: { type: "object", anyOf: [] } }))?.code).toBe("schema_invalid");
    const spec = await callTool("define_tool", { ...STANDUP, spec: { nope: 1 } });
    expect(errorOf(spec)?.code).toBe("spec_invalid");
    expect(errorOf(spec)?.hint).toContain("spec:");
    await define();
    const dup = await callTool("define_tool", STANDUP);
    expect(errorOf(dup)?.code).toBe("name_taken");
    expect(errorOf(dup)?.hint).toContain("replace:true");
  });
  it("refuses the 201st definition but still allows replace", async () => {
    const stmts = Array.from({ length: 200 }, (_, i) =>
      env.DB.prepare("INSERT INTO tool_defs(name, kind, title, description, input_schema, spec, annotations, created_by) VALUES (?1, 'template', ?1, ?1, '{\"type\":\"object\",\"properties\":{}}', '{\"text\":\"seed\"}', '{}', 'seed')").bind(`seed_${i}`));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    const r = await callTool("define_tool", STANDUP);
    expect(errorOf(r)?.code).toBe("slot_budget_exceeded");
    expect(errorOf(r)?.message).toContain("200");
    expect(errorOf(r)?.details).toMatchObject({ definitions: 200, max: 200 });
    const replaced = await callTool("define_tool", { ...STANDUP, name: "seed_7", replace: true });
    expect(errorOf(replaced), textOf(replaced)).toBeUndefined();
    expect(structuredOf(replaced)).toMatchObject({ version: 2 });
  });
});

describe("toggle_tool", () => {
  it("flips when enabled is omitted and reports the deciding layer", async () => {
    await define();
    const off = await callTool("toggle_tool", { name: "standup" });
    expect(errorOf(off)).toBeUndefined();
    expect(structuredOf(off)).toMatchObject({ enabled: false, decidedBy: { enabled: "deploy" }, scope: "deploy" });
    expect(textOf(off)).toContain("switched off");
    const blocked = await callTool("call_tool", { name: "standup", arguments: { project: "x" } });
    expect(errorOf(blocked)?.code).toBe("tool_disabled");
    expect(errorOf(blocked)?.message).toContain("deploy layer");
    const on = await callTool("toggle_tool", { name: "standup" });
    expect(structuredOf(on)).toMatchObject({ enabled: true, decidedBy: { enabled: "deploy" } });
    expect(errorOf(await callTool("call_tool", { name: "standup", arguments: { project: "x" } }))).toBeUndefined();
  });
  it("refuses protected tools with protected_tool on toggle, promote and demote", async () => {
    for (const name of PROTECTED) {
      expect(errorOf(await callTool("toggle_tool", { name, enabled: false }))?.code).toBe("protected_tool");
      expect(errorOf(await callTool("demote_tool", { name }))?.code).toBe("protected_tool");
    }
    expect(errorOf(await callTool("promote_tool", { name: "list_tools" }))).toBeUndefined();   // promoting a protected tool is a no-op
    expect(await toolNames()).toEqual(DEFAULT_VISIBLE_TOOLS);
  });
  it("unknown tools get unknown_tool with nearest names", async () => {
    const r = await callTool("toggle_tool", { name: "rememberr" });
    expect(errorOf(r)?.code).toBe("unknown_tool");
    expect(errorOf(r)?.hint).toContain("remember");
  });
});

describe("two principals: static token and an OAuth label", () => {
  let oauth: string;
  beforeAll(async () => { oauth = (await oauthDance({ label: "claude-code" })).accessToken; });

  it("whoami distinguishes them", async () => {
    expect(structuredOf<{ principal: { via: string; clientKey: string } }>(await callTool("whoami")).principal).toMatchObject({ via: "token", clientKey: "token" });
    expect(structuredOf<{ principal: { via: string; clientKey: string } }>(await callTool("whoami", {}, oauth)).principal).toMatchObject({ via: "oauth", clientKey: "claude-code" });
  });
  it("a deploy disable of remember hides it and refuses call_tool for both principals", async () => {
    const r = await callTool("toggle_tool", { name: "remember", enabled: false });
    expect(errorOf(r)).toBeUndefined();
    for (const token of [undefined, oauth]) {
      expect(await toolNames(token)).not.toContain("remember");
      const blocked = await callTool("call_tool", { name: "remember", arguments: { content: "x" } }, token);
      expect(errorOf(blocked)?.code).toBe("tool_disabled");
      expect(errorOf(blocked)?.hint).toContain("deploy");
      expect((await callToolRaw("remember", { content: "x" }, token)).error?.message).toMatch(/not found|disabled|unknown/i);
    }
    // a client cannot undo it
    const attempt = await callTool("toggle_tool", { name: "remember", enabled: true, scope: "client" }, oauth);
    expect(errorOf(attempt)).toBeUndefined();
    expect(structuredOf(attempt)).toMatchObject({ enabled: false, deployDisabled: true, decidedBy: { enabled: "deploy" } });
    expect(textOf(attempt)).toContain("deploy layer still has it off");
    expect(await toolNames(oauth)).not.toContain("remember");
  });
  it("a client-scope disable affects only that label; enabled:true clears it", async () => {
    const off = await callTool("toggle_tool", { name: "recall", enabled: false, scope: "client" }, oauth);
    expect(structuredOf(off)).toMatchObject({ enabled: false, clientKey: "claude-code", decidedBy: { enabled: "client" } });
    expect(await toolNames(oauth)).not.toContain("recall");
    expect(await toolNames()).toContain("recall");
    expect(errorOf(await callTool("call_tool", { name: "recall", arguments: {} }, oauth))?.code).toBe("tool_disabled");
    expect(errorOf(await callTool("call_tool", { name: "recall", arguments: {} }))).toBeUndefined();
    const on = await callTool("toggle_tool", { name: "recall", enabled: true, scope: "client" }, oauth);
    expect(structuredOf(on)).toMatchObject({ enabled: true, decidedBy: { enabled: "builtin" } });
    expect(await toolNames(oauth)).toContain("recall");
  });
  it("a client promote lists a definition only for that key; the token acts for another key via client:", async () => {
    await define({}, oauth);
    const p = await callTool("promote_tool", { name: "standup", scope: "client" }, oauth);
    expect(errorOf(p)).toBeUndefined();
    expect(structuredOf(p)).toMatchObject({ clientKey: "claude-code", scope: "client" });
    expect(await toolNames(oauth)).toContain("standup");
    expect(await toolNames()).not.toContain("standup");
    expect(structuredOf<{ budget: { usedClient: number; usedDeploy: number } }>(await callTool("list_tools", {}, oauth)).budget).toMatchObject({ usedClient: 1, usedDeploy: 0 });
    // the static token demotes it for the label
    const d = await callTool("demote_tool", { name: "standup", scope: "client", client: "claude-code" });
    expect(errorOf(d)).toBeUndefined();
    expect(await toolNames(oauth)).not.toContain("standup");
    // client demote of a built-in hides it for that label only
    await callTool("demote_tool", { name: "whoami", scope: "client" }, oauth);
    expect(await toolNames(oauth)).not.toContain("whoami");
    expect(await toolNames()).toContain("whoami");
    expect(structuredOf<{ principal: { via: string } }>(await callTool("call_tool", { name: "whoami" }, oauth)).principal.via).toBe("oauth");
  });
});

describe("override_tool and remove_tool", () => {
  it("override_tool changes the title in tools/list for every principal and reset restores it", async () => {
    const before = (await toolsList()).find((t) => t.name === "whoami")!.title;
    const r = await hidden("override_tool", { name: "whoami", title: "Who dis", description: "Identity check" });
    expect(errorOf(r)).toBeUndefined();
    const entry = (await toolsList()).find((t) => t.name === "whoami")!;
    expect(entry.title).toBe("Who dis");
    expect(entry.description).toBe("Identity check");
    expect(errorOf(await hidden("override_tool", { name: "whoami" }))?.code).toBe("invalid_arguments");
    await hidden("override_tool", { name: "whoami", reset: true });
    expect((await toolsList()).find((t) => t.name === "whoami")!.title).toBe(before);
  });
  it("remove_tool deletes the definition and its overrides; built-ins are not_a_definition; confirm is required", async () => {
    await define();
    await callTool("promote_tool", { name: "standup" });
    expect(await toolNames()).toContain("standup");
    expect(errorOf(await hidden("remove_tool", { name: "standup" }))?.code).toBe("invalid_arguments");
    expect(errorOf(await hidden("remove_tool", { name: "standup", confirm: false }))?.code).toBe("invalid_arguments");
    expect(errorOf(await hidden("remove_tool", { name: "remember", confirm: true }))?.code).toBe("not_a_definition");
    const r = await hidden("remove_tool", { name: "standup", confirm: true });
    expect(errorOf(r)).toBeUndefined();
    expect(structuredOf(r)).toMatchObject({ removed: true, kind: "template" });
    expect(await toolNames()).not.toContain("standup");
    expect(errorOf(await callTool("call_tool", { name: "standup", arguments: { project: "x" } }))?.code).toBe("unknown_tool");
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM tool_overrides WHERE tool_name='standup'").first<{ n: number }>();
    expect(rows?.n).toBe(0);
    await define();                                                   // the name is free again and starts hidden
    expect((await listState("standup"))?.promoted).toBe(false);
  });
});

describe("catalog_version and budget", () => {
  it("increments once per mutation", async () => {
    let v = await catalogVersion();
    const steps: (() => Promise<unknown>)[] = [
      () => define(),
      () => callTool("promote_tool", { name: "standup" }),
      () => callTool("demote_tool", { name: "standup" }),
      () => callTool("toggle_tool", { name: "standup", enabled: false }),
      () => callTool("toggle_tool", { name: "standup", enabled: true }),
      () => hidden("override_tool", { name: "standup", title: "T" }),
      () => hidden("remove_tool", { name: "standup", confirm: true })
    ];
    for (const step of steps) {
      await step();
      const next = await catalogVersion();
      expect(next).toBe(v + 1);
      v = next;
    }
    expect((await env.DB.prepare("SELECT count(*) AS n FROM registry_events").first<{ n: number }>())?.n).toBe(steps.length);
    expect(await catalogVersion()).toBe(v);                          // reads never bump
  });
  it("slot_budget_exceeded once the budget (lowered to 2) is filled; demote frees a slot; define promote:true honours it", async () => {
    await env.DB.prepare("UPDATE settings SET value='2' WHERE key='promoted_budget'").run();
    for (const name of ["a1", "a2", "a3"]) await define({ name });
    expect(errorOf(await callTool("promote_tool", { name: "a1" }))).toBeUndefined();
    expect(errorOf(await callTool("promote_tool", { name: "a2" }))).toBeUndefined();
    expect(errorOf(await callTool("promote_tool", { name: "a2" }))).toBeUndefined();      // idempotent re-promote never counts twice
    const full = await callTool("promote_tool", { name: "a3" });
    expect(errorOf(full)?.code).toBe("slot_budget_exceeded");
    expect(errorOf(full)?.details).toMatchObject({ scope: "deploy", used: 2, limit: 2, promoted: ["a1", "a2"] });
    const viaDefine = await callTool("define_tool", { ...STANDUP, name: "a4", promote: true });
    expect(errorOf(viaDefine)?.code).toBe("slot_budget_exceeded");
    expect(await toolNames()).toEqual(expect.arrayContaining(["a1", "a2"]));
    expect(await toolNames()).not.toContain("a3");
    expect(errorOf(await callTool("demote_tool", { name: "a1" }))).toBeUndefined();
    expect(errorOf(await callTool("promote_tool", { name: "a3" }))).toBeUndefined();
    const r = await callTool("define_tool", { ...STANDUP, name: "a5", promote: true });
    expect(errorOf(r)?.code).toBe("slot_budget_exceeded");
    await callTool("demote_tool", { name: "a2" });
    const ok = await callTool("define_tool", { ...STANDUP, name: "a5", promote: true });
    expect(errorOf(ok)).toBeUndefined();
    expect(structuredOf(ok)).toMatchObject({ visible: true });
    expect(structuredOf<{ budget: { usedDeploy: number; limit: number } }>(await callTool("list_tools")).budget).toMatchObject({ usedDeploy: 2, limit: 2 });
  });
});

describe("call_tool and describe_tool", () => {
  it("call_tool refuses unknown names with nearest hints, itself with depth_exceeded, and passes results through", async () => {
    const unknown = await callTool("call_tool", { name: "rememberr" });
    expect(errorOf(unknown)?.code).toBe("unknown_tool");
    expect(errorOf(unknown)?.hint).toContain("Nearest: remember");
    expect(errorOf(await callTool("call_tool", { name: "call_tool", arguments: { name: "whoami" } }))?.code).toBe("depth_exceeded");
    const hidden = await callTool("call_tool", { name: "list_upstreams" });
    expect(errorOf(hidden)).toBeUndefined();
    const info = structuredOf<{ name: string; endpoint: string; tools: { builtin: number }; schema: string; snippets: { claudeAdd: string } }>(await callTool("call_tool", { name: "server_info" }));
    expect(info).toMatchObject({ name: TEST_IDENTITY, endpoint: "https://homcp.test/mcp", schema: "ok", tools: { builtin: 22 } });
    expect(info.snippets.claudeAdd).toBe(`claude mcp add --transport http --scope user ${TEST_IDENTITY} https://homcp.test/mcp`);
  });
  it("describe_tool shows the input view of built-in schemas, override rows and redacts definition secrets", async () => {
    const t = structuredOf<{ inputSchema: { required?: string[]; properties: Record<string, unknown> }; claudeCodeName: string; protected: boolean; overrides: unknown[] }>(await callTool("describe_tool", { name: "toggle_tool" }));
    expect(t.inputSchema.required).toEqual(["name"]);
    expect(Object.keys(t.inputSchema.properties).sort()).toEqual(["client", "enabled", "name", "scope"]);
    expect(t.claudeCodeName).toBe(`mcp__${TEST_IDENTITY}__toggle_tool`);
    expect(t.protected).toBe(true);
    expect(t.overrides).toEqual([]);

    await hidden("override_tool", { name: "whoami", title: "Who dis" });
    const w = structuredOf<{ overrides: { scope: string; title: string | null }[]; title: string }>(await callTool("describe_tool", { name: "whoami" }));
    expect(w.title).toBe("Who dis");
    expect(w.overrides).toEqual([expect.objectContaining({ scope: "deploy", title: "Who dis" })]);

    const http = await callTool("define_tool", {
      name: "fetch_items", kind: "http", description: "Fetch items",
      input_schema: { type: "object", properties: { q: { type: "string" } } },
      spec: { url: "https://api.example.com/v1/items?q={{input.q}}&token=literal-token-1", headers: { authorization: "Bearer {{secret:X}}", "x-api-key": "literal-key-123", accept: "application/json" } }
    });
    expect(errorOf(http), textOf(http)).toBeUndefined();
    const d = await callTool("describe_tool", { name: "fetch_items" });
    const spec = structuredOf<{ spec: { url: string; headers: Record<string, string> } }>(d).spec;
    expect(spec.headers.authorization).toBe("Bearer {{secret:X}}");
    expect(spec.headers["x-api-key"]).toBe("•••");
    expect(spec.headers.accept).toBe("application/json");
    expect(spec.url).toContain("token=•••");
    expect(textOf(d)).not.toContain("literal-key-123");
    expect(textOf(d)).not.toContain("literal-token-1");
    expect(textOf(d)).not.toContain("s3cret");
    expect(JSON.stringify(d)).not.toContain("s3cret");
  });
});
