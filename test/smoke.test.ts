import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const B = "https://homcp.example.com";
const rpc = (body: unknown, token?: string) =>
  SELF.fetch(`${B}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe("spike smoke", () => {
  it("serves health", async () => {
    const r = await SELF.fetch(`${B}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, name: "homcp" });
  });
  it("advertises CIMD + S256 + none", async () => {
    const r = await SELF.fetch(`${B}/.well-known/oauth-authorization-server`);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.client_id_metadata_document_supported).toBe(true);
    expect(j.code_challenge_methods_supported).toEqual(["S256"]);
    expect(j.token_endpoint_auth_methods_supported).toContain("none");
  });
  it("PRM resource equals /mcp url", async () => {
    const r = await SELF.fetch(`${B}/.well-known/oauth-protected-resource/mcp`);
    expect(((await r.json()) as { resource: string }).resource).toBe(`${B}/mcp`);
  });
  it("401 with resource_metadata when no token", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
  it("static token: two initializes, no session id, tools/list without session, GET 405", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
    const a = await rpc(init, "test-token");
    const b = await rpc(init, "test-token");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get("mcp-session-id")).toBeNull();
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "test-token");
    expect(list.status).toBe(200);
    expect(await list.text()).toContain('"whoami"');
    const get = await SELF.fetch(`${B}/mcp`, { headers: { authorization: "Bearer test-token" } });
    expect(get.status).toBe(405);
  });
});
