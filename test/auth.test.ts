// test/auth.test.ts [A] — §18 "auth" row: the OAuth door (401 challenge → PRM → AS metadata) and the static-token door.
import { describe, expect, it } from "vitest";
import { BASE, MCP_URL, TEST_PASSPHRASE, TEST_TOKEN, callTool, get, json, mcp, rpc, structuredOf } from "./helpers";

/** whoami's principal, whether the tool nests it under `principal` or spreads it at the top level. */
function principalOf(result: Parameters<typeof structuredOf>[0]): { via?: string; clientKey?: string; clientName?: string } {
  const s = structuredOf<Record<string, unknown>>(result);
  return (s.principal && typeof s.principal === "object" ? s.principal : s) as { via?: string; clientKey?: string; clientName?: string };
}

describe("OAuth door on /mcp", () => {
  it("no bearer → 401 with WWW-Authenticate pointing at the path-suffixed protected-resource metadata", async () => {
    const res = await mcp(rpc("tools/list"), { token: null });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer/i);
    expect(challenge).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("garbage bearer → 401 invalid_token", async () => {
    const res = await mcp(rpc("tools/list"), { token: "not-a-real-token" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain('error="invalid_token"');
    const body = await json<{ error: string }>(res);
    expect(body.error).toBe("invalid_token");
  });

  it("the owner passphrase is not a bearer token → 401", async () => {
    const res = await mcp(rpc("tools/list"), { token: TEST_PASSPHRASE });
    expect(res.status).toBe(401);
  });

  it("protected-resource metadata: /mcp resource is the endpoint URL and the AS is this origin", async () => {
    const suffixed = await json<{ resource: string; authorization_servers: string[] }>(await get("/.well-known/oauth-protected-resource/mcp"));
    expect(suffixed.resource).toBe(MCP_URL);
    expect(suffixed.authorization_servers[0]).toBe(BASE);
    const root = await json<{ resource: string; authorization_servers: string[] }>(await get("/.well-known/oauth-protected-resource"));
    expect(root.authorization_servers[0]).toBe(BASE);
    expect([BASE, MCP_URL]).toContain(root.resource);        // provider derives it from the path suffix (root → origin)
  });

  it("authorization-server metadata advertises CIMD, public clients, S256, DCR and RFC 9207 iss", async () => {
    const meta = await json<Record<string, unknown>>(await get("/.well-known/oauth-authorization-server"));
    expect(meta.issuer).toBe(BASE);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.token_endpoint_auth_methods_supported).toContain("none");
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.registration_endpoint).toBe(`${BASE}/oauth/register`);
    expect(meta.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(meta.token_endpoint).toBe(`${BASE}/oauth/token`);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
  });
});

describe("static-token door on /mcp", () => {
  it("MCP_API_TOKEN as bearer → whoami reports via token, clientKey token", async () => {
    const r = await callTool("whoami", {}, TEST_TOKEN);
    expect(r.isError).toBeFalsy();
    const p = principalOf(r);
    expect(p.via).toBe("token");
    expect(p.clientKey).toBe("token");
  });

  it("the static door is exact-match on /mcp — a different path falls through to the OAuth provider", async () => {
    const res = await mcp(rpc("tools/list"), { url: `${BASE}/mcp/other` });
    expect(res.status).toBe(401);
  });

  it("the static token is compared case-sensitively and whole", async () => {
    expect((await mcp(rpc("tools/list"), { token: TEST_TOKEN.toUpperCase() })).status).toBe(401);
    expect((await mcp(rpc("tools/list"), { token: `${TEST_TOKEN}x` })).status).toBe(401);
    expect((await mcp(rpc("tools/list"), { token: TEST_TOKEN.slice(0, -1) })).status).toBe(401);
  });
});
