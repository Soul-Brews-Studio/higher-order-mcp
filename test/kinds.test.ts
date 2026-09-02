// test/kinds.test.ts [C] — §18: define_tool kinds through the real server (SELF.fetch). http via an outbound.fetch stub;
// mcp via the loopback seam (outbound.fetch = SELF.fetch); compose over the memory tools.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { callTool, errorOf, structuredOf, textOf, toolNames, TEST_TOKEN } from "./helpers";
import { env } from "cloudflare:test";
import { outbound } from "../src/registry/upstream";
import { httpKind } from "../src/registry/kinds/http";
import type { ExecContext, Identity, Principal, RequestScope, ResolvedCatalog, ResolvedTool } from "../src/types";

const realFetch = outbound.fetch;
interface Call { url: URL; init: RequestInit }
function stubFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  outbound.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return calls;
}
const loopback = ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as string | URL, init)) as typeof fetch;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// Minimal scope/catalog/tool for exercising a kind's run() directly (bypassing define_tool validation on purpose).
const fakeIdentity: Identity = { name: "homcp-test", instructions: "", source: "var" };
const fakePrincipal: Principal = { userId: "owner", via: "token", clientKey: "token", scopes: [] };
function fakeExec(): ExecContext {
  const url = new URL("https://homcp.test/mcp");
  const scope = { env, ctx: {} as ExecutionContext, url, origin: url.origin, host: url.host, principal: fakePrincipal, hop: 0 } as unknown as RequestScope;
  const catalog = { tools: new Map(), visible: [], budget: { limit: 12, usedDeploy: 0, usedClient: 0 }, identity: fakeIdentity, principal: fakePrincipal, catalogVersion: 1, upstreams: [], schemaMissing: false, warnings: [] } as unknown as ResolvedCatalog;
  return { scope, catalog, depth: 0 };
}
function fakeHttpTool(name: string, spec: Record<string, unknown>): ResolvedTool {
  return { name, kind: "http", protected: false, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }, inputSchema: {} as never, inputSchemaJson: {}, spec,
    state: { enabled: true, promoted: false, title: name, description: name, decidedBy: { enabled: "builtin", promoted: "builtin" }, deployDisabled: false } };
}

afterEach(() => { outbound.fetch = realFetch; });

async function define(def: Record<string, unknown>) {
  return callTool("define_tool", { description: `test ${def.name}`, ...def });
}
/** Hidden built-ins are registered but disable()d: direct tools/call says "disabled"; call_tool reaches them (§10.1). */
async function hidden(name: string, args: Record<string, unknown> = {}) {
  return callTool("call_tool", { name, arguments: args });
}
function expectOk(r: Awaited<ReturnType<typeof callTool>>, label: string) {
  if (r.isError) throw new Error(`${label}: ${textOf(r)}`);
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
describe("http kind", () => {
  it("GET json + json_path renders the url and picks the value", async () => {
    const calls = stubFetch(() => json({ data: { temp: 21, unit: "C" } }));
    expectOk(await define({ name: "wx", kind: "http", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false },
      spec: { url: "https://api.example.com/v1/weather?city={{input.city}}", json_path: "data.temp" } }), "define wx");
    const r = expectOk(await callTool("call_tool", { name: "wx", arguments: { city: "Oslo" } }), "call wx");
    expect(textOf(r)).toBe("21");
    expect(structuredOf(r)).toEqual({ value: 21 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.hostname).toBe("api.example.com");
    expect(calls[0]!.url.searchParams.get("city")).toBe("Oslo");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.method).toBe("GET");
    const meta = (r as { _meta?: { homcp?: Record<string, unknown> } })._meta?.homcp;
    expect(meta?.status).toBe(200);
  });
  it("json response without json_path becomes structuredContent; text stays text", async () => {
    stubFetch((url) => (url.pathname === "/t" ? new Response("plain body", { headers: { "content-type": "text/plain" } }) : json({ ok: true, n: 1 })));
    expectOk(await define({ name: "j", kind: "http", spec: { url: "https://api.example.com/j" } }), "define j");
    expectOk(await define({ name: "t", kind: "http", spec: { url: "https://api.example.com/t" } }), "define t");
    const j = expectOk(await callTool("call_tool", { name: "j" }), "call j");
    expect(structuredOf(j)).toEqual({ ok: true, n: 1 });
    const t = expectOk(await callTool("call_tool", { name: "t" }), "call t");
    expect(textOf(t)).toBe("plain body");
    expect(t.structuredContent).toBeUndefined();
  });
  it("POST renders a JSON body with input values", async () => {
    const calls = stubFetch(() => json({ created: true }));
    expectOk(await define({ name: "mk", kind: "http", input_schema: { type: "object", properties: { n: { type: "number" }, tag: { type: "string" } } },
      spec: { method: "POST", url: "https://api.example.com/items", body: { count: "{{= input.n}}", label: "tag-{{input.tag}}", who: "{{principal.clientKey}}" } } }), "define mk");
    const r = expectOk(await callTool("call_tool", { name: "mk", arguments: { n: 3, tag: "x" } }), "call mk");
    expect(structuredOf(r)).toEqual({ created: true });
    expect(calls[0]!.init.method).toBe("POST");
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ count: 3, label: "tag-x", who: "token" });
  });
  it("rejects non-https, literal IPs, localhost, *.internal and placeholders in the host at define time", async () => {
    const bad = ["http://api.example.com/x", "https://10.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://app.localhost/x", "https://db.internal/x", "https://printer.local/x", "https://nas.home.arpa/x", "https://{{input.h}}.example.com/x", "https://api.example.com{{input.h}}", "https://user:pw@api.example.com/x", "https://intranet/x"];
    for (const url of bad) {
      const r = await define({ name: "bad_http", kind: "http", spec: { url } });
      expect(errorOf(r)?.code, url).toBe("spec_invalid");
    }
    const good = await define({ name: "good_http", kind: "http", spec: { url: "https://api.example.com/{{input.p}}?q={{input.q}}" } });
    expect(good.isError, textOf(good)).toBeFalsy();
  });
  it("rejects GET with a body, secrets in the body, bad json_path and allowed_hosts without the url host", async () => {
    expect(errorOf(await define({ name: "b1", kind: "http", spec: { url: "https://api.example.com/x", body: "x" } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "b2", kind: "http", spec: { method: "POST", url: "https://api.example.com/x", body: { k: "{{secret:X}}" } } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "b3", kind: "http", spec: { url: "https://api.example.com/x", json_path: "a..b" } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "b4", kind: "http", spec: { url: "https://api.example.com/x", allowed_hosts: ["other.example.com"] } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "b5", kind: "http", spec: { url: "https://api.example.com/x", allowed_hosts: ["127.0.0.1"] } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "b6", kind: "http", spec: { url: "https://api.example.com/x", headers: { "x-k": "{{env.X}}" } } }))?.code).toBe("spec_invalid");
  });
  it("a rendered host outside allowed_hosts is refused at call time (runtime re-check, independent of define-time policy)", async () => {
    const calls = stubFetch(() => json({}));
    // A definition whose host policy was somehow bypassed (e.g. edited in D1): run() must still refuse.
    const tool = fakeHttpTool("esc", { url: "https://evil.example.com/x", allowed_hosts: ["api.example.com"] });
    const r = await httpKind.run(tool, {}, fakeExec());
    expect(errorOf(r)?.code).toBe("http_blocked_host");
    expect(calls).toHaveLength(0);
    const ipTool = fakeHttpTool("ip", { url: "https://10.0.0.1/x", allowed_hosts: ["10.0.0.1"] });
    expect(errorOf(await httpKind.run(ipTool, {}, fakeExec()))?.code).toBe("http_blocked_host");
    const plain = fakeHttpTool("plain", { url: "http://api.example.com/x", allowed_hosts: ["api.example.com"] });
    expect(errorOf(await httpKind.run(plain, {}, fakeExec()))?.code).toBe("http_blocked_host");
    expect(calls).toHaveLength(0);
    const fine = await httpKind.run(fakeHttpTool("ok", { url: "https://api.example.com/ok?p={{input.p}}" }), { p: "1" }, fakeExec());
    expect(fine.isError).toBeFalsy();
    expect(calls[0]!.url.toString()).toBe("https://api.example.com/ok?p=1");
  });
  it("non-2xx → http_failed with status and a body preview; redirects are not followed", async () => {
    stubFetch((url) => (url.pathname === "/r" ? new Response("", { status: 302, headers: { location: "https://elsewhere.example.com/" } }) : new Response("boom".repeat(1000), { status: 503 })));
    expectOk(await define({ name: "fails", kind: "http", spec: { url: "https://api.example.com/fail" } }), "define");
    const r = await callTool("call_tool", { name: "fails" });
    const err = errorOf(r);
    expect(err?.code).toBe("http_failed");
    expect((err?.details as { status: number; body: string }).status).toBe(503);
    expect((err?.details as { status: number; body: string }).body.length).toBeLessThanOrEqual(2048);
    expectOk(await define({ name: "redir", kind: "http", spec: { url: "https://api.example.com/r" } }), "define redir");
    const r2 = await callTool("call_tool", { name: "redir" });
    expect(errorOf(r2)?.code).toBe("http_failed");
    expect(textOf(r2)).toContain("302");
  });
  it("max_bytes caps the body with an http_too_large note; oversized JSON is an error", async () => {
    stubFetch((url) => (url.pathname === "/big.json" ? json({ pad: "x".repeat(5000) }) : new Response("y".repeat(5000), { headers: { "content-type": "text/plain" } })));
    expectOk(await define({ name: "big", kind: "http", spec: { url: "https://api.example.com/big.txt", max_bytes: 1024 } }), "define big");
    const r = expectOk(await callTool("call_tool", { name: "big" }), "call big");
    expect(textOf(r)).toContain("http_too_large");
    expect(textOf(r).startsWith("y".repeat(1024))).toBe(true);
    expect(textOf(r)).not.toContain("y".repeat(1025));
    expectOk(await define({ name: "bigj", kind: "http", spec: { url: "https://api.example.com/big.json", max_bytes: 1024, response: "json" } }), "define bigj");
    expect(errorOf(await callTool("call_tool", { name: "bigj" }))?.code).toBe("http_too_large");
  });
  it("timeout → http_timeout", async () => {
    stubFetch((_url, init) => new Promise<Response>((_, reject) => { init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted"))); }));
    expectOk(await define({ name: "slow", kind: "http", spec: { url: "https://api.example.com/slow", timeout_ms: 1000 } }), "define slow");
    const started = Date.now();
    const r = await callTool("call_tool", { name: "slow" });
    expect(errorOf(r)?.code).toBe("http_timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
  it("{{secret:X}} in headers resolves from HOMCP_SECRET_X and is never echoed", async () => {
    const calls = stubFetch(() => json({ ok: 1 }));
    expectOk(await define({ name: "sec", kind: "http", spec: { url: "https://api.example.com/private?token={{secret:X}}", headers: { "x-api-key": "{{secret:X}}", authorization: "Bearer {{secret:X}}" } } }), "define sec");
    expectOk(await callTool("call_tool", { name: "sec" }), "call sec");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("x-api-key")).toBe("s3cret");
    expect(h.get("authorization")).toBe("Bearer s3cret");
    expect(calls[0]!.url.searchParams.get("token")).toBe("s3cret");
    const d = expectOk(await callTool("describe_tool", { name: "sec" }), "describe sec");
    expect(JSON.stringify(d)).not.toContain("s3cret");
    expect(JSON.stringify(d)).toContain("{{secret:X}}");
    const l = expectOk(await callTool("list_tools", {}), "list_tools");
    expect(JSON.stringify(l)).not.toContain("s3cret");
    expect(errorOf(await define({ name: "sec2", kind: "http", spec: { url: "https://api.example.com/x", headers: { k: "{{secret:MISSING}}" } } }))?.code).toBe("spec_invalid");
  });
  it("default annotations follow the method", async () => {
    stubFetch(() => json({}));
    expectOk(await define({ name: "h_get", kind: "http", spec: { url: "https://api.example.com/a" } }), "get");
    expectOk(await define({ name: "h_del", kind: "http", spec: { method: "DELETE", url: "https://api.example.com/a" } }), "delete");
    expectOk(await define({ name: "h_post", kind: "http", spec: { method: "POST", url: "https://api.example.com/a" } }), "post");
    const ann = async (name: string) => structuredOf<{ annotations: Record<string, boolean> }>(expectOk(await callTool("describe_tool", { name }), name)).annotations;
    expect(await ann("h_get")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(await ann("h_del")).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(await ann("h_post")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("template kind", () => {
  it("renders text and parses format json into structuredContent", async () => {
    expectOk(await define({ name: "standup", kind: "template", input_schema: { type: "object", properties: { project: { type: "string" } }, required: ["project"] },
      spec: { text: "Standup for {{input.project}} on {{now.date}} by {{principal.clientKey}}" } }), "define standup");
    const r = expectOk(await callTool("call_tool", { name: "standup", arguments: { project: "homcp" } }), "call standup");
    expect(textOf(r)).toMatch(/^Standup for homcp on \d{4}-\d{2}-\d{2} by token$/);
    expectOk(await define({ name: "tj", kind: "template", input_schema: { type: "object", properties: { n: { type: "number" } } }, spec: { text: '{"n": {{json input.n}}, "who": "{{identity.name}}"}', format: "json" } }), "define tj");
    const j = expectOk(await callTool("call_tool", { name: "tj", arguments: { n: 5 } }), "call tj");
    expect(structuredOf(j)).toEqual({ n: 5, who: "homcp-test" });
    expect(errorOf(await define({ name: "tbad", kind: "template", spec: { text: "{{env.X}}" } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "tsec", kind: "template", spec: { text: "{{secret:X}}" } }))?.code).toBe("spec_invalid");
    const d = structuredOf<{ annotations: Record<string, boolean> }>(expectOk(await callTool("describe_tool", { name: "standup" }), "describe"));
    expect(d.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("mcp kind (loopback through SELF)", () => {
  beforeAll(async () => {
    outbound.fetch = loopback;
    const r = await hidden("add_upstream", { name: "self", url: "https://homcp.test/mcp", auth: { kind: "bearer", value: TEST_TOKEN } });
    if (r.isError) throw new Error(`add_upstream self: ${textOf(r)}`);
  });
  beforeEach(() => { outbound.fetch = loopback; });

  it("add_upstream caches the tool list and never echoes the token", async () => {
    const l = expectOk(await hidden("list_upstreams"), "list_upstreams");
    const rows = structuredOf<{ upstreams: Array<{ name: string; auth_kind: string; tool_count: number }> }>(l).upstreams;
    expect(rows.map((u) => u.name)).toEqual(["self"]);
    expect(rows[0]!.auth_kind).toBe("bearer");
    expect(rows[0]!.tool_count).toBeGreaterThanOrEqual(15);
    expect(JSON.stringify(l)).not.toContain(TEST_TOKEN);
  });
  it("define_tool {kind:mcp} snapshots the upstream schema and call_tool proxies", async () => {
    const d = expectOk(await define({ name: "stats", kind: "mcp", spec: { upstream: "self", tool: "memory_stats" } }), "define stats");
    expect(structuredOf<{ kind: string }>(d).kind).toBe("mcp");
    const desc = structuredOf<{ inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }>(expectOk(await callTool("describe_tool", { name: "stats" }), "describe stats"));
    expect(desc.inputSchema.type).toBe("object");
    expect(desc.annotations.readOnlyHint).toBe(true);          // inherited from memory_stats
    const r = expectOk(await callTool("call_tool", { name: "stats" }), "call stats");
    expect(r.isError).toBeFalsy();
    expect(textOf(r).length).toBeGreaterThan(0);
    const meta = (r as { _meta?: { homcp?: Record<string, unknown> } })._meta?.homcp;
    expect(meta?.upstream).toBe("self");
    expect(await toolNames()).not.toContain("stats");         // hidden until promote_tool
  });
  it("bind fills upstream arguments and drops them from the snapshot schema", async () => {
    expectOk(await define({ name: "note", kind: "mcp", spec: { upstream: "self", tool: "remember", bind: { kind: "note", tags: ["via-proxy"], title: "proxied {{input.content}}" } } }), "define note");
    const desc = structuredOf<{ inputSchema: { properties: Record<string, unknown>; required?: string[] } }>(expectOk(await callTool("describe_tool", { name: "note" }), "describe note"));
    expect(Object.keys(desc.inputSchema.properties)).toContain("content");
    expect(Object.keys(desc.inputSchema.properties)).not.toContain("kind");
    expect(desc.inputSchema.required ?? []).not.toContain("kind");
    const r = expectOk(await callTool("call_tool", { name: "note", arguments: { content: "hello" } }), "call note");
    expect(r.isError).toBeFalsy();
    const id = structuredOf<{ id: string }>(r).id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const read = structuredOf<{ title: string }>(expectOk(await callTool("read_memory", { id }), "read"));
    expect(read.title).toBe("proxied hello");
  });
  it("unknown upstream / missing tool are refused at define time", async () => {
    expect(errorOf(await define({ name: "u1", kind: "mcp", spec: { upstream: "nope", tool: "x" } }))?.code).toBe("unknown_upstream");
    expect(errorOf(await define({ name: "u2", kind: "mcp", spec: { upstream: "self", tool: "no_such_tool" } }))?.code).toBe("upstream_tool_missing");
  });
  it("upstream tool errors pass through with the upstream prefix", async () => {
    expectOk(await define({ name: "rd", kind: "mcp", spec: { upstream: "self", tool: "read_memory" } }), "define rd");
    const r = await callTool("call_tool", { name: "rd", arguments: { id: ZERO_UUID } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^upstream self: not_found/);
    expect(errorOf(r)?.code).toBe("not_found");
  });
  it("a definition proxying itself stops with hop_limit within 3 hops", async () => {
    expectOk(await define({ name: "loop", kind: "mcp", spec: { upstream: "self", tool: "call_tool", bind: { name: "loop" } } }), "define loop");
    const r = await callTool("call_tool", { name: "loop" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("hop_limit");
    expect(errorOf(r)?.code).toBe("hop_limit");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe("compose kind", () => {
  it("remember → read_memory with {{steps.s1.structured.id}}", async () => {
    expectOk(await define({ name: "note_read", kind: "compose", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      spec: { steps: [
        { id: "s1", tool: "remember", args: { content: "{{input.text}}", title: "compose-test", tags: ["compose"] } },
        { id: "s2", tool: "read_memory", args: { id: "{{steps.s1.structured.id}}" } }
      ] } }), "define note_read");
    const r = expectOk(await callTool("call_tool", { name: "note_read", arguments: { text: "hello from compose" } }), "call note_read");
    const s = structuredOf<{ steps: Record<string, { text: string; structured: { id: string }; isError: boolean }>; last: { id: string; content: string } }>(r);
    expect(Object.keys(s.steps)).toEqual(["s1", "s2"]);
    expect(s.last.id).toBe(s.steps.s1!.structured.id);
    expect(s.last.content).toBe("hello from compose");
    expect(textOf(r)).toContain("hello from compose");
  });
  it("on_error stop → compose_step_failed with partial steps; continue proceeds", async () => {
    const steps = [{ id: "s1", tool: "read_memory", args: { id: ZERO_UUID } }, { id: "s2", tool: "memory_stats", args: {} }];
    expectOk(await define({ name: "c_stop", kind: "compose", spec: { steps, on_error: "stop" } }), "define c_stop");
    const stop = await callTool("call_tool", { name: "c_stop" });
    const err = errorOf(stop);
    expect(err?.code).toBe("compose_step_failed");
    const details = err?.details as { step: string; steps: Record<string, unknown> };
    expect(details.step).toBe("s1");
    expect(Object.keys(details.steps)).toEqual(["s1"]);
    expectOk(await define({ name: "c_go", kind: "compose", spec: { steps, on_error: "continue", output: "all" } }), "define c_go");
    const go = expectOk(await callTool("call_tool", { name: "c_go" }), "call c_go");
    const s = structuredOf<{ steps: Record<string, { isError: boolean }> }>(go);
    expect(Object.keys(s.steps)).toEqual(["s1", "s2"]);
    expect(s.steps.s1!.isError).toBe(true);
    expect(s.steps.s2!.isError).toBe(false);
    expect(textOf(go)).toContain("## s1 (read_memory) — error");
    expect(textOf(go)).toContain("## s2 (memory_stats)");
  });
  it("self-reference, duplicate ids, unknown tools, forward step refs and call_tool are rejected", async () => {
    expect(errorOf(await define({ name: "selfy", kind: "compose", spec: { steps: [{ id: "a", tool: "selfy" }] } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "dup", kind: "compose", spec: { steps: [{ id: "a", tool: "memory_stats" }, { id: "a", tool: "memory_stats" }] } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "unk", kind: "compose", spec: { steps: [{ id: "a", tool: "no_such_tool" }] } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "fwd", kind: "compose", spec: { steps: [{ id: "a", tool: "recall", args: { query: "{{steps.b.text}}" } }, { id: "b", tool: "memory_stats" }] } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "viacall", kind: "compose", spec: { steps: [{ id: "a", tool: "call_tool", args: { name: "memory_stats" } }] } }))?.code).toBe("spec_invalid");
    expect(errorOf(await define({ name: "bad_id", kind: "compose", spec: { steps: [{ id: "Bad Id", tool: "memory_stats" }] } }))?.code).toBe("spec_invalid");
  });
  it("disabled step tools are refused with tool_disabled", async () => {
    expectOk(await callTool("toggle_tool", { name: "memory_stats", enabled: false }), "disable memory_stats");
    expect(errorOf(await define({ name: "dis", kind: "compose", spec: { steps: [{ id: "a", tool: "memory_stats" }] } }))?.code).toBe("tool_disabled");
    expectOk(await callTool("toggle_tool", { name: "memory_stats", enabled: true }), "re-enable memory_stats");
  });
  it("nesting deeper than MAX_DEPTH fails with depth_exceeded; shallow chains work", async () => {
    expectOk(await define({ name: "leaf", kind: "template", spec: { text: "leaf" } }), "leaf");
    expectOk(await define({ name: "d4", kind: "compose", spec: { steps: [{ id: "a", tool: "leaf" }] } }), "d4");
    expectOk(await define({ name: "d3", kind: "compose", spec: { steps: [{ id: "a", tool: "d4" }] } }), "d3");
    expectOk(await define({ name: "d2", kind: "compose", spec: { steps: [{ id: "a", tool: "d3" }] } }), "d2");
    expectOk(await define({ name: "d1", kind: "compose", spec: { steps: [{ id: "a", tool: "d2" }] } }), "d1");
    const shallow = expectOk(await callTool("call_tool", { name: "d3" }), "call d3");     // d3 → d4 → leaf
    expect(textOf(shallow)).toBe("leaf");
    const deep = await callTool("call_tool", { name: "d1" });                              // d1 → d2 → d3 → d4 → leaf
    expect(deep.isError).toBe(true);
    expect(errorOf(deep)?.code).toBe("compose_step_failed");
    expect(JSON.stringify(deep)).toContain("depth_exceeded");
  });
  it("default annotations fold over the steps", async () => {
    expectOk(await define({ name: "ro_pair", kind: "compose", spec: { steps: [{ id: "a", tool: "memory_stats" }, { id: "b", tool: "recall", args: { query: "x" } }] } }), "ro_pair");
    expectOk(await define({ name: "rw_pair", kind: "compose", spec: { steps: [{ id: "a", tool: "memory_stats" }, { id: "b", tool: "remember", args: { content: "x" } }] } }), "rw_pair");
    const ann = async (name: string) => structuredOf<{ annotations: Record<string, boolean> }>(expectOk(await callTool("describe_tool", { name }), name)).annotations;
    expect(await ann("ro_pair")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect((await ann("rw_pair")).readOnlyHint).toBe(false);
  });
});
