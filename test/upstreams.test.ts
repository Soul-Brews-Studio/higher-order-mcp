// test/upstreams.test.ts [C] — §18: list_upstreams never leaks auth_value; remove_upstream → upstream_in_use while
// referenced, force deletes dependents; upstream_tools cached vs refresh. All through SELF with the loopback seam.
// The four upstream tools are hidden built-ins: registered but disable()d, so they are reached through call_tool.
// D1 state persists across the tests of this file, so every test cleans up the upstreams it created.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { callTool, errorOf, structuredOf, textOf, toolNames, TEST_TOKEN } from "./helpers";
import { outbound } from "../src/registry/upstream";

const realFetch = outbound.fetch;
let calls = 0;
const loopback = ((input: RequestInfo | URL, init?: RequestInit) => { calls++; return SELF.fetch(input as string | URL, init); }) as typeof fetch;
const MCP_URL = "https://homcp.test/mcp";

/** Hidden built-ins are registered but disable()d: direct tools/call says "disabled"; call_tool reaches them (§10.1). */
async function hidden(name: string, args: Record<string, unknown> = {}) {
  return callTool("call_tool", { name, arguments: args });
}
function expectOk(r: Awaited<ReturnType<typeof callTool>>, label: string) {
  if (r.isError) throw new Error(`${label}: ${textOf(r)}`);
  return r;
}
async function addSelf(name: string) {
  return expectOk(await hidden("add_upstream", { name, url: MCP_URL, auth: { kind: "bearer", value: TEST_TOKEN } }), `add_upstream ${name}`);
}
async function upstreamNames(): Promise<string[]> {
  return structuredOf<{ upstreams: Array<{ name: string }> }>(expectOk(await hidden("list_upstreams"), "list_upstreams")).upstreams.map((u) => u.name);
}

beforeEach(() => { outbound.fetch = loopback; calls = 0; });
afterEach(async () => {
  outbound.fetch = realFetch;
  for (const name of await upstreamNames()) await hidden("remove_upstream", { name, force: true });
});

describe("add_upstream", () => {
  it("connects once, stores the tool cache and returns a define_tool example without the token", async () => {
    const r = await addSelf("self");
    const s = structuredOf<{ name: string; tools: string[]; example: { kind: string; spec: { upstream: string; tool: string } }; plaintextBearer: boolean }>(r);
    expect(s.name).toBe("self");
    expect(s.tools).toContain("memory_stats");
    expect(s.tools).toContain("list_tools");
    expect(s.example.kind).toBe("mcp");
    expect(s.example.spec.upstream).toBe("self");
    expect(s.plaintextBearer).toBe(true);
    expect(textOf(r)).toContain("define_tool");
    expect(JSON.stringify(r)).not.toContain(TEST_TOKEN);
    expect(calls).toBeGreaterThan(0);
    expect(errorOf(await hidden("add_upstream", { name: "self", url: MCP_URL }))?.code).toBe("name_taken");
    expect(await upstreamNames()).toEqual(["self"]);
  });
  it("validates name, url, secret and reachability without storing anything", async () => {
    expect(errorOf(await hidden("add_upstream", { name: "Bad Name", url: MCP_URL }))?.code).toBe("invalid_arguments");
    expect(errorOf(await hidden("add_upstream", { name: "plain", url: "http://homcp.test/mcp" }))?.code).toBe("spec_invalid");
    expect(errorOf(await hidden("add_upstream", { name: "ip", url: "https://127.0.0.1/mcp" }))?.code).toBe("spec_invalid");
    expect(errorOf(await hidden("add_upstream", { name: "loc", url: "https://localhost/mcp" }))?.code).toBe("spec_invalid");
    expect(errorOf(await hidden("add_upstream", { name: "nosecret", url: MCP_URL, auth: { kind: "secret", value: "MISSING" } }))?.code).toBe("spec_invalid");
    expect(errorOf(await hidden("add_upstream", { name: "nobearer", url: MCP_URL, auth: { kind: "bearer" } }))?.code).toBe("spec_invalid");
    const unauth = await hidden("add_upstream", { name: "unauth", url: MCP_URL });
    expect(errorOf(unauth)?.code).toBe("upstream_unreachable");           // no bearer → 401 at /mcp
    outbound.fetch = (async () => { throw new TypeError("fetch failed: ENOTFOUND"); }) as unknown as typeof fetch;
    const down = await hidden("add_upstream", { name: "down", url: "https://nowhere.example.com/mcp" });
    expect(errorOf(down)?.code).toBe("upstream_unreachable");
    expect(textOf(down)).toContain("ENOTFOUND");
    outbound.fetch = loopback;
    expect(await upstreamNames()).toEqual([]);
  });
  it("auth kind secret resolves HOMCP_SECRET_X at connect time (wrong token → unreachable, never stored or echoed)", async () => {
    const r = await hidden("add_upstream", { name: "viasecret", url: MCP_URL, auth: { kind: "secret", value: "X" } });
    expect(errorOf(r)?.code).toBe("upstream_unreachable");           // HOMCP_SECRET_X="s3cret" is not the static token
    expect(JSON.stringify(r)).not.toContain("s3cret");
    expect(await upstreamNames()).toEqual([]);
  });
});

describe("list_upstreams", () => {
  it("shows redacted rows with tool counts and referencing definitions", async () => {
    await addSelf("listed");
    expectOk(await callTool("define_tool", { name: "stats_proxy", kind: "mcp", description: "proxy", spec: { upstream: "listed", tool: "memory_stats" } }), "define");
    const r = expectOk(await hidden("list_upstreams"), "list_upstreams");
    const rows = structuredOf<{ upstreams: Array<Record<string, unknown>> }>(r).upstreams;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.name).toBe("listed");
    expect(row.url).toBe(MCP_URL);
    expect(row.auth_kind).toBe("bearer");
    expect(row.tool_count).toBeGreaterThanOrEqual(15);
    expect(typeof row.cached_at).toBe("string");
    expect(row.definitions).toEqual(["stats_proxy"]);
    expect(row).not.toHaveProperty("auth_value");
    expect(row).not.toHaveProperty("tool_cache");
    expect(JSON.stringify(r)).not.toContain(TEST_TOKEN);
    expect(textOf(r)).toContain("stats_proxy");
    expect(textOf(r)).not.toContain(TEST_TOKEN);
  });
  it("is empty when nothing is registered", async () => {
    const r = expectOk(await hidden("list_upstreams"), "list_upstreams");
    expect(structuredOf<{ upstreams: unknown[] }>(r).upstreams).toEqual([]);
    expect(textOf(r)).toContain("add_upstream");
  });
});

describe("remove_upstream", () => {
  it("refuses while mcp definitions reference it; force deletes them too", async () => {
    await addSelf("rm");
    expectOk(await callTool("define_tool", { name: "p1", kind: "mcp", description: "p1", spec: { upstream: "rm", tool: "memory_stats" }, promote: true }), "define p1");
    expectOk(await callTool("define_tool", { name: "p2", kind: "mcp", description: "p2", spec: { upstream: "rm", tool: "recall" } }), "define p2");
    expect(await toolNames()).toContain("p1");
    const busy = await hidden("remove_upstream", { name: "rm" });
    expect(errorOf(busy)?.code).toBe("upstream_in_use");
    expect((errorOf(busy)?.details as { definitions: string[] }).definitions).toEqual(["p1", "p2"]);
    expect(await toolNames()).toContain("p1");
    const forced = expectOk(await hidden("remove_upstream", { name: "rm", force: true }), "force");
    expect(structuredOf<{ removedDefinitions: string[] }>(forced).removedDefinitions).toEqual(["p1", "p2"]);
    expect(textOf(forced)).toContain("Refresh tools list");
    expect(await toolNames()).not.toContain("p1");
    const list = structuredOf<{ tools: Array<{ name: string }> }>(expectOk(await callTool("list_tools"), "list_tools")).tools.map((t) => t.name);
    expect(list).not.toContain("p1");
    expect(list).not.toContain("p2");
    expect(await upstreamNames()).toEqual([]);
    expect(errorOf(await hidden("remove_upstream", { name: "rm" }))?.code).toBe("unknown_upstream");
  });
  it("removes an unreferenced upstream without touching tools", async () => {
    await addSelf("other");
    const before = await toolNames();
    const r = expectOk(await hidden("remove_upstream", { name: "other" }), "remove");
    expect(structuredOf<{ removedDefinitions: string[] }>(r).removedDefinitions).toEqual([]);
    expect(textOf(r)).not.toContain("Refresh tools list");
    expect(await toolNames()).toEqual(before);
    expect(await upstreamNames()).toEqual([]);
  });
});

describe("upstream_tools", () => {
  it("serves the cache without a round trip and refreshes live on request", async () => {
    await addSelf("ut");
    calls = 0;
    const cached = expectOk(await hidden("upstream_tools", { upstream: "ut" }), "cached");
    expect(calls).toBe(0);
    const c = structuredOf<{ source: string; total: number; tools: Array<{ name: string; inputSchema?: unknown }> }>(cached);
    expect(c.source).toBe("cache");
    expect(c.total).toBeGreaterThanOrEqual(15);
    expect(c.tools.find((t) => t.name === "remember")?.inputSchema).toBeTruthy();
    expect(textOf(cached)).toContain("define_tool");
    const live = expectOk(await hidden("upstream_tools", { upstream: "ut", refresh: true }), "live");
    expect(calls).toBeGreaterThan(0);
    expect(structuredOf<{ source: string }>(live).source).toBe("live");
    const filtered = structuredOf<{ tools: Array<{ name: string; description?: string; title?: string }>; total: number }>(expectOk(await hidden("upstream_tools", { upstream: "ut", filter: "memory" }), "filter"));
    expect(filtered.tools.length).toBeGreaterThan(0);
    expect(filtered.tools.length).toBeLessThan(filtered.total);
    for (const t of filtered.tools) expect(`${t.name} ${t.title ?? ""} ${t.description ?? ""}`.toLowerCase()).toContain("memory");
    expect(errorOf(await hidden("upstream_tools", { upstream: "ghost" }))?.code).toBe("unknown_upstream");
    expect(JSON.stringify(live)).not.toContain(TEST_TOKEN);
  });
});
