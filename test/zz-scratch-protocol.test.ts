// THROWAWAY probe file — deleted after the review run.
import { env } from "cloudflare:test";
import { beforeEach, describe, it } from "vitest";
import { BASE, callTool, callToolRaw, errorOf, legacyInit, mcp, modern, modernBody, readJsonRpc, rpc, structuredOf, textOf, toolsList } from "./helpers";

const log = (label: string, v: unknown) => console.log(`\n### ${label}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);
async function resetRegistry() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tool_overrides"), env.DB.prepare("DELETE FROM tool_defs"), env.DB.prepare("DELETE FROM upstreams"),
    env.DB.prepare("DELETE FROM registry_events"), env.DB.prepare("DELETE FROM settings WHERE key LIKE 'identity_%'"),
    env.DB.prepare("UPDATE settings SET value='12' WHERE key='promoted_budget'")
  ]);
}
beforeEach(resetRegistry);

describe("scratch protocol probes", () => {
  it("A origin header on non-workers.dev host", async () => {
    const res = await mcp(rpc("tools/list"), { headers: { origin: "https://homcp.test" } });
    log("A1 same-origin Origin", { status: res.status, body: await res.text() });
    const res2 = await mcp(rpc("tools/list"), { headers: { origin: "http://localhost:6274" } });
    log("A2 localhost Origin", { status: res2.status });
    const res3 = await mcp(rpc("tools/list"), { headers: { origin: "null" } });
    log("A3 Origin null", { status: res3.status, body: (await res3.text()).slice(0, 200) });
  });

  it("B direct tools/call invalid args shape vs call_tool; defaults; extra props", async () => {
    const d = await callTool("define_tool", { name: "standup", kind: "template", description: "d", input_schema: { type: "object", properties: { project: { type: "string" }, n: { type: "integer", default: 5 }, flag: { type: "boolean" } }, required: ["project"], additionalProperties: false }, spec: { text: "P={{input.project}} N={{input.n}} F={{input.flag}}" }, promote: true });
    log("B define", { err: errorOf(d), text: textOf(d).slice(0, 200) });
    log("B direct invalid", await callToolRaw("standup", {}));
    log("B call_tool invalid", await callTool("call_tool", { name: "standup", arguments: {} }));
    log("B direct ok (default applied?)", await callToolRaw("standup", { project: "x" }));
    log("B tools/list entry", (await toolsList()).find((t) => t.name === "standup"));
    log("B describe inputSchema", structuredOf(await callTool("describe_tool", { name: "standup" })).inputSchema);
    log("B extra prop", await callToolRaw("standup", { project: "x", zzz: 1 }));
    log("B wrong type", await callToolRaw("standup", { project: 5 }));
  });

  it("C builtin schema required/defaults in tools/list", async () => {
    const list = await toolsList();
    for (const n of ["list_tools", "call_tool", "remember", "read_memory", "toggle_tool"]) log(`C ${n}`, list.find((t) => t.name === n)?.inputSchema);
  });

  it("D hidden tool direct call error", async () => {
    log("D hidden direct", await callToolRaw("set_identity", {}));
    log("D unknown direct", await callToolRaw("nope", {}));
    const m = await modern("tools/call", { name: "set_identity", arguments: {} });
    log("D hidden modern", { status: m.status, body: (await m.text()).slice(0, 400) });
  });

  it("E legacy header combos and version echo", async () => {
    const a = await mcp(rpc("tools/list"), { headers: { "mcp-protocol-version": "2026-07-28" } });
    log("E1 legacy body + modern header", { status: a.status, body: (await a.text()).slice(0, 300) });
    const b = await mcp(rpc("tools/list"), { headers: { "mcp-protocol-version": "2025-06-18" } });
    log("E2 legacy body + legacy header", { status: b.status });
    const c = await mcp(rpc("tools/list"), { headers: { "mcp-protocol-version": "1999-01-01" } });
    log("E3 legacy body + bogus header", { status: c.status, body: (await c.text()).slice(0, 300) });
    log("E4 init 2024-11-05", await readJsonRpc(await mcp(legacyInit("2024-11-05"))));
    log("E5 init 2026-07-28 legacy body", await readJsonRpc(await mcp(legacyInit("2026-07-28"))));
    log("E6 init 2025-03-26", (await readJsonRpc<{ protocolVersion: string }>(await mcp(legacyInit("2025-03-26")))).result?.protocolVersion);
    log("E7 init garbage", await readJsonRpc(await mcp(legacyInit("garbage"))));
  });

  it("F accept variants", async () => {
    const a = await mcp(rpc("tools/list"), { headers: { accept: "application/json" } });
    log("F1 legacy accept json only", { status: a.status, ct: a.headers.get("content-type"), body: (await a.text()).slice(0, 300) });
    const b = await modern("tools/list", {}, { headers: { accept: "application/json" } });
    log("F2 modern accept json only", { status: b.status, ct: b.headers.get("content-type"), body: (await b.text()).slice(0, 300) });
    const c = await modern("tools/list", {}, { headers: { accept: "text/event-stream" } });
    log("F3 modern accept sse only", { status: c.status, ct: c.headers.get("content-type") });
    const d = await mcp(rpc("tools/list"));
    log("F4 legacy default accept both", { status: d.status, headers: [...d.headers.entries()] });
    const e = await modern("tools/list");
    log("F5 modern default accept both", { status: e.status, headers: [...e.headers.entries()] });
    const f = await mcp(rpc("tools/list"), { headers: { accept: "*/*" } });
    log("F6 legacy accept */*", { status: f.status, body: (await f.text()).slice(0, 200) });
  });

  it("G paths with static token", async () => {
    for (const p of ["/mcp/", "/mcp/other", "/mcpx", "/MCP"]) {
      const r = await mcp(rpc("tools/list"), { url: `${BASE}${p}` });
      log(`G ${p}`, { status: r.status, www: r.headers.get("www-authenticate"), body: (await r.text()).slice(0, 200) });
    }
  });

  it("H modern tools/call response after define_tool (list_changed inline?)", async () => {
    const res = await modern("tools/call", { name: "define_tool", arguments: { name: "t2", kind: "template", description: "d", spec: { text: "hi" } } });
    log("H status/ct", { status: res.status, ct: res.headers.get("content-type") });
    log("H body", (await res.text()).slice(0, 2500));
    const leg = await mcp(rpc("tools/call", { name: "define_tool", arguments: { name: "t3", kind: "template", description: "d", spec: { text: "hi" } } }));
    log("H legacy body", (await leg.text()).slice(0, 2500));
  });

  it("I x-mcp-header in define_tool input_schema", async () => {
    const r = await callTool("define_tool", { name: "hdr", kind: "template", description: "d", input_schema: { type: "object", properties: { auth: { type: "string", "x-mcp-header": "Authorization" } }, additionalProperties: false }, spec: { text: "auth={{input.auth}}" }, promote: true });
    log("I define", { err: errorOf(r), text: textOf(r).slice(0, 300) });
    const res = await modern("tools/call", { name: "hdr", arguments: {} });
    log("I modern call", { status: res.status, body: (await res.text()).slice(0, 800) });
    const res2 = await modern("tools/call", { name: "hdr", arguments: {} }, { headers: { "mcp-param-auth": "leak", "x-auth": "leak2" } });
    log("I modern call with extra headers", { status: res2.status, body: (await res2.text()).slice(0, 800) });
    log("I legacy call", await callToolRaw("hdr", {}));
    log("I tools/list entry", (await toolsList()).find((t) => t.name === "hdr"));
  });

  it("J mcp-method mismatch and missing", async () => {
    const a = await mcp(modernBody("tools/list"), { headers: { "mcp-protocol-version": "2026-07-28" } });
    log("J1 modern no Mcp-Method", { status: a.status, body: (await a.text()).slice(0, 300) });
    const b = await mcp(modernBody("tools/list"), { headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" } });
    log("J2 modern mismatched Mcp-Method", { status: b.status, body: (await b.text()).slice(0, 300) });
    const c = await mcp(modernBody("tools/list"), { headers: { "mcp-method": "tools/list" } });
    log("J3 modern body no version header", { status: c.status, body: (await c.text()).slice(0, 300) });
  });

  it("K fail() projection on both lanes", async () => {
    log("K legacy fail", (await callToolRaw("call_tool", { name: "nope" })).result);
    const res = await modern("tools/call", { name: "call_tool", arguments: { name: "nope" } });
    log("K modern fail", (await res.text()).slice(0, 1200));
  });

  it("L notification and batch on legacy", async () => {
    const a = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    log("L notif", { status: a.status, body: await a.text() });
    const b = await mcp([rpc("tools/list"), rpc("tools/list")]);
    log("L batch", { status: b.status, body: (await b.text()).slice(0, 300) });
  });

  it("M schema defaults/format/coercion via call_tool", async () => {
    const d = await callTool("define_tool", { name: "def", kind: "template", description: "d", input_schema: { type: "object", properties: { n: { type: "integer", default: 5 }, when: { type: "string", format: "date-time" }, tags: { type: "array", items: { type: "string" }, default: [] } } }, spec: { text: "N={{input.n}} W={{input.when}} T={{json input.tags}}" } });
    log("M define", { err: errorOf(d), warnings: structuredOf(d).warnings });
    log("M default via call_tool", await callTool("call_tool", { name: "def", arguments: {} }));
    log("M bad format", await callTool("call_tool", { name: "def", arguments: { when: "not-a-date" } }));
    log("M string for integer", await callTool("call_tool", { name: "def", arguments: { n: "5" } }));
    log("M float for integer", await callTool("call_tool", { name: "def", arguments: { n: 5.5 } }));
  });

  it("N subscriptions/listen receives tools_list_changed from another request", async () => {
    const res = await modern("subscriptions/listen", { toolsListChanged: true });
    log("N listen status", { status: res.status, ct: res.headers.get("content-type") });
    if (!res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readFor = async (ms: number) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        const r = await Promise.race([reader.read(), new Promise<{ done: boolean; value?: Uint8Array; timeout: true }>((ok) => setTimeout(() => ok({ done: false, timeout: true }), 250))]);
        if ("timeout" in r) continue;
        if (r.value) buf += dec.decode(r.value);
        if (r.done) break;
      }
    };
    await readFor(700);
    log("N initial", buf);
    await callTool("define_tool", { name: "t9", kind: "template", description: "d", spec: { text: "hi" } });
    await readFor(1500);
    log("N after define", buf);
    await reader.cancel().catch(() => {});
  });
});
