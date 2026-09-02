// test/resolve.test.ts [B] — §18 resolve row: the precedence table of §10.1 against the pure resolver (§10.2).
// Uses the real BUILTINS so the 15/7 default split is locked here as well as over the wire (registry/stateless tests).
import { describe, expect, it } from "vitest";
import { emptySnapshot } from "../src/registry/db";
import { resolveCatalog } from "../src/registry/resolve";
import { BUILTINS, HIDDEN_BY_DEFAULT, PROTECTED } from "../src/tools/builtin";
import type { Identity, OverrideScope, Principal, Snapshot, ToolDefRow, ToolOverrideRow } from "../src/types";
import { DEFAULT_HIDDEN_TOOLS, DEFAULT_VISIBLE_TOOLS } from "./helpers";

const IDENTITY: Identity = { name: "homcp-test", instructions: "x", source: "var" };
const TOKEN: Principal = { userId: "owner", via: "token", clientKey: "token", scopes: [] };
const CLAUDE: Principal = { userId: "owner", via: "oauth", clientKey: "claude-code", scopes: [] };

function def(name: string, extra: Partial<ToolDefRow> = {}): ToolDefRow {
  return { name, kind: "template", title: `${name} title`, description: `${name} description`, input_schema: '{"type":"object","properties":{"q":{"type":"string"}},"additionalProperties":false}', spec: '{"text":"hi {{input.q}}"}', annotations: '{"readOnlyHint":true}', created_by: "token", created_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z", version: 1, ...extra };
}
function ov(scope: OverrideScope, tool_name: string, patch: Partial<Pick<ToolOverrideRow, "enabled" | "promoted" | "title" | "description">>, client_key = ""): ToolOverrideRow {
  return { scope, client_key: scope === "deploy" ? "" : client_key || "token", tool_name, enabled: null, promoted: null, title: null, description: null, updated_by: "test", updated_at: "", ...patch };
}
function snap(p: { defs?: ToolDefRow[]; overrides?: ToolOverrideRow[]; budget?: number; schemaMissing?: boolean; version?: number } = {}): Snapshot {
  return { ...emptySnapshot(), schemaMissing: p.schemaMissing ?? false, catalogVersion: p.version ?? 7, promotedBudget: p.budget ?? 12, defs: p.defs ?? [], overrides: p.overrides ?? [] };
}
const resolve = (s: Snapshot, principal: Principal = TOKEN) => resolveCatalog(BUILTINS, s, principal, IDENTITY);
const names = (c: ReturnType<typeof resolve>) => c.visible.map((t) => t.name);

describe("defaults", () => {
  it("lists the 15 default tools, hides the 7 hidden ones, 22 in total, sorted", () => {
    const c = resolve(snap());
    expect(c.tools.size).toBe(22);
    expect(names(c)).toEqual(DEFAULT_VISIBLE_TOOLS);
    const hidden = [...c.tools.values()].filter((t) => t.state.enabled && !t.state.promoted).map((t) => t.name).sort();
    expect(hidden).toEqual(DEFAULT_HIDDEN_TOOLS);
    expect([...HIDDEN_BY_DEFAULT].sort()).toEqual(DEFAULT_HIDDEN_TOOLS);
    for (const t of c.tools.values()) {
      expect(t.kind).toBe("builtin");
      expect(t.protected).toBe(PROTECTED.has(t.name));
      expect(t.state.decidedBy).toEqual({ enabled: "builtin", promoted: "builtin" });
      expect(t.inputSchemaJson.type).toBe("object");
    }
    expect(c.budget).toEqual({ limit: 12, usedDeploy: 0, usedClient: 0 });
    expect(c.warnings).toEqual([]);
    expect(c.catalogVersion).toBe(7);
    expect(c.identity).toBe(IDENTITY);
    expect(c.principal).toBe(TOKEN);
  });
});

describe("enabled: deploy → client, disable is sticky downward", () => {
  it("deploy disable switches a built-in off for everyone", () => {
    const c = resolve(snap({ overrides: [ov("deploy", "remember", { enabled: 0 })] }));
    const t = c.tools.get("remember")!;
    expect(t.state.enabled).toBe(false);
    expect(t.state.deployDisabled).toBe(true);
    expect(t.state.decidedBy.enabled).toBe("deploy");
    expect(names(c)).not.toContain("remember");
    expect(names(c)).toHaveLength(14);
  });
  it("a client cannot re-enable a deploy-disabled tool", () => {
    const c = resolve(snap({ overrides: [ov("deploy", "remember", { enabled: 0 }), ov("client", "remember", { enabled: 1 })] }));
    const t = c.tools.get("remember")!;
    expect(t.state.enabled).toBe(false);
    expect(t.state.decidedBy.enabled).toBe("deploy");
  });
  it("a client can disable a tool for itself and restore it by dropping the row", () => {
    const off = resolve(snap({ overrides: [ov("client", "recall", { enabled: 0 })] }));
    expect(off.tools.get("recall")!.state.enabled).toBe(false);
    expect(off.tools.get("recall")!.state.decidedBy.enabled).toBe("client");
    expect(off.tools.get("recall")!.state.deployDisabled).toBe(false);
    const restored = resolve(snap({ overrides: [] }));
    expect(restored.tools.get("recall")!.state.enabled).toBe(true);
    expect(restored.tools.get("recall")!.state.decidedBy.enabled).toBe("builtin");
  });
  it("a deploy enabled=1 row restores a tool and a client enabled=1 row wins over nothing", () => {
    const c = resolve(snap({ overrides: [ov("deploy", "recall", { enabled: 1 }), ov("client", "recall", { enabled: 1 })] }));
    expect(c.tools.get("recall")!.state.enabled).toBe(true);
    expect(c.tools.get("recall")!.state.decidedBy.enabled).toBe("client");
  });
});

describe("protected tools are immune", () => {
  it("ignores deploy and client rows on list_tools / call_tool", () => {
    const c = resolve(snap({ overrides: [ov("deploy", "list_tools", { enabled: 0, promoted: 0 }), ov("client", "call_tool", { enabled: 0, promoted: 0 }), ov("deploy", "toggle_tool", { enabled: 0 })] }));
    for (const name of PROTECTED) {
      const t = c.tools.get(name)!;
      expect(t.protected).toBe(true);
      expect(t.state.enabled).toBe(true);
      expect(t.state.promoted).toBe(true);
      expect(t.state.deployDisabled).toBe(false);
      expect(t.state.decidedBy).toEqual({ enabled: "builtin", promoted: "builtin" });
    }
    expect(names(c)).toEqual(DEFAULT_VISIBLE_TOOLS);
  });
  it("still takes a deploy title override", () => {
    const c = resolve(snap({ overrides: [ov("deploy", "list_tools", { title: "Catalog" })] }));
    expect(c.tools.get("list_tools")!.state.title).toBe("Catalog");
  });
});

describe("promoted: client > deploy > default", () => {
  it("definitions are enabled but hidden by default", () => {
    const c = resolve(snap({ defs: [def("standup")] }));
    const t = c.tools.get("standup")!;
    expect(t.kind).toBe("template");
    expect(t.protected).toBe(false);
    expect(t.state).toMatchObject({ enabled: true, promoted: false, title: "standup title", description: "standup description", deployDisabled: false });
    expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(t.spec).toEqual({ text: "hi {{input.q}}" });
    expect(t.def?.version).toBe(1);
    expect(names(c)).not.toContain("standup");
    expect(c.tools.size).toBe(23);
  });
  it("deploy promote lists a definition; a client demote hides it for that client only", () => {
    const deploy = resolve(snap({ defs: [def("standup")], overrides: [ov("deploy", "standup", { promoted: 1 })] }));
    expect(deploy.tools.get("standup")!.state.promoted).toBe(true);
    expect(deploy.tools.get("standup")!.state.decidedBy.promoted).toBe("deploy");
    expect(names(deploy)).toContain("standup");
    const client = resolve(snap({ defs: [def("standup")], overrides: [ov("deploy", "standup", { promoted: 1 }), ov("client", "standup", { promoted: 0 })] }));
    expect(client.tools.get("standup")!.state.promoted).toBe(false);
    expect(client.tools.get("standup")!.state.decidedBy.promoted).toBe("client");
    expect(names(client)).not.toContain("standup");
  });
  it("a client promote lists a definition when the deploy layer is silent", () => {
    const c = resolve(snap({ defs: [def("standup")], overrides: [ov("client", "standup", { promoted: 1 })] }));
    expect(c.tools.get("standup")!.state.promoted).toBe(true);
    expect(c.tools.get("standup")!.state.decidedBy.promoted).toBe("client");
    expect(names(c)).toContain("standup");
    expect(c.budget.usedClient).toBe(1);
    expect(c.budget.usedDeploy).toBe(0);
  });
  it("built-ins can be demoted (hidden, still enabled) and hidden built-ins promoted", () => {
    const c = resolve(snap({ overrides: [ov("client", "whoami", { promoted: 0 }), ov("deploy", "set_identity", { promoted: 1 })] }));
    expect(c.tools.get("whoami")!.state).toMatchObject({ enabled: true, promoted: false });
    expect(c.tools.get("set_identity")!.state).toMatchObject({ enabled: true, promoted: true });
    expect(names(c)).not.toContain("whoami");
    expect(names(c)).toContain("set_identity");
    expect(c.budget.usedDeploy).toBe(0);            // built-ins never count against the budget
  });
  it("a promoted but disabled tool is not visible", () => {
    const c = resolve(snap({ defs: [def("standup")], overrides: [ov("deploy", "standup", { promoted: 1, enabled: 0 })] }));
    expect(c.tools.get("standup")!.state.promoted).toBe(true);
    expect(names(c)).not.toContain("standup");
  });
});

describe("title / description overrides", () => {
  it("deploy overrides win over the definition and over code; client rows and empty strings are ignored", () => {
    const c = resolve(snap({
      defs: [def("standup")],
      overrides: [ov("deploy", "standup", { title: "Daily standup", description: "Your standup" }), ov("deploy", "whoami", { title: "Who dis" }), ov("client", "recall", { title: "Nope" }), ov("deploy", "remember", { title: "" })]
    }));
    expect(c.tools.get("standup")!.state.title).toBe("Daily standup");
    expect(c.tools.get("standup")!.state.description).toBe("Your standup");
    expect(c.tools.get("whoami")!.state.title).toBe("Who dis");
    expect(c.tools.get("recall")!.state.title).not.toBe("Nope");
    expect(c.tools.get("remember")!.state.title).not.toBe("");
  });
});

describe("visible ordering, budget and warnings", () => {
  it("sorts visible by name with definitions interleaved", () => {
    const c = resolve(snap({ defs: [def("zeta"), def("alpha"), def("mid_tool")], overrides: [ov("deploy", "zeta", { promoted: 1 }), ov("deploy", "alpha", { promoted: 1 }), ov("deploy", "mid_tool", { promoted: 1 })] }));
    expect(names(c)).toEqual([...DEFAULT_VISIBLE_TOOLS, "alpha", "mid_tool", "zeta"].sort());
    expect(c.budget.usedDeploy).toBe(3);
  });
  it("counts promoted definitions per layer and warns when the deploy layer is over budget", () => {
    const c = resolve(snap({
      budget: 2,
      defs: [def("a"), def("b"), def("c"), def("d")],
      overrides: [ov("deploy", "a", { promoted: 1 }), ov("deploy", "b", { promoted: 1 }), ov("deploy", "c", { promoted: 1 }), ov("client", "d", { promoted: 1 })]
    }));
    expect(c.budget).toEqual({ limit: 2, usedDeploy: 3, usedClient: 1 });
    expect(c.warnings).toHaveLength(1);
    expect(c.warnings[0]).toContain("3 promoted definitions");
    expect(c.warnings[0]).toContain("budget is 2");
    expect(names(c)).toEqual(expect.arrayContaining(["a", "b", "c", "d"]));   // over budget only warns, never hides
  });
  it("warns when the schema is missing and keeps the built-ins", () => {
    const c = resolve(emptySnapshot());
    expect(c.schemaMissing).toBe(true);
    expect(c.warnings.some((w) => /not migrated/.test(w))).toBe(true);
    expect(names(c)).toEqual(DEFAULT_VISIBLE_TOOLS);
    expect(c.catalogVersion).toBe(0);
  });
  it("ignores stale override rows and skips unreadable or shadowing definitions with a warning", () => {
    const c = resolve(snap({
      defs: [def("broken", { input_schema: "{not json" }), def("remember"), def("fine")],
      overrides: [ov("deploy", "ghost", { enabled: 0 }), ov("deploy", "fine", { promoted: 1 })]
    }));
    expect(c.tools.has("broken")).toBe(false);
    expect(c.tools.has("ghost")).toBe(false);
    expect(c.tools.get("remember")!.kind).toBe("builtin");
    expect(c.tools.get("fine")!.state.promoted).toBe(true);
    expect(c.warnings.some((w) => w.includes("broken") && w.includes("unreadable"))).toBe(true);
    expect(c.warnings.some((w) => w.includes("remember") && w.includes("shadows"))).toBe(true);
  });
});

describe("determinism", () => {
  it("produces the same catalog for shuffled inputs and repeated runs", () => {
    const defs = [def("zeta"), def("alpha"), def("mid_tool")];
    const overrides = [ov("deploy", "zeta", { promoted: 1 }), ov("client", "alpha", { promoted: 1 }), ov("deploy", "remember", { enabled: 0 }), ov("deploy", "whoami", { title: "Who dis" })];
    const a = resolve(snap({ defs, overrides }), CLAUDE);
    const b = resolve(snap({ defs: [...defs].reverse(), overrides: [...overrides].reverse() }), CLAUDE);
    const c = resolve(snap({ defs, overrides }), CLAUDE);
    const shape = (x: typeof a) => [...x.tools.values()].map((t) => [t.name, t.state]).sort();
    expect(names(a)).toEqual(names(b));
    expect(names(a)).toEqual(names(c));
    expect(shape(a)).toEqual(shape(b));
    expect(shape(a)).toEqual(shape(c));
    expect(a.budget).toEqual(b.budget);
  });
  it("never mutates the built-in specs", () => {
    const before = JSON.stringify(BUILTINS.map((b) => [b.name, b.title, b.description, b.protected, b.hiddenByDefault]));
    resolve(snap({ overrides: [ov("deploy", "whoami", { title: "Who dis", enabled: 0 }), ov("deploy", "set_identity", { promoted: 1 })] }));
    expect(JSON.stringify(BUILTINS.map((b) => [b.name, b.title, b.description, b.protected, b.hiddenByDefault]))).toBe(before);
  });
});
