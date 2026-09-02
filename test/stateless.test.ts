// test/stateless.test.ts [A] — §18 "stateless" row: the /mcp endpoint keeps no session, answers both protocol lanes,
// identifies itself with the identity + package version, and lists tools deterministically with private cache hints.
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import {
  BASE, DEFAULT_VISIBLE_TOOLS, LEGACY_VERSION, LEGACY_VERSION_NEWER, MODERN_VERSION, TEST_IDENTITY,
  legacyInit, mcp, modern, oauthDance, readJsonRpc, rpc, toolNames
} from "./helpers";

interface InitResult { protocolVersion: string; serverInfo: { name: string; version: string; title?: string }; capabilities: { tools?: { listChanged?: boolean } }; instructions?: string }

describe("stateless /mcp — legacy lane (2025)", () => {
  for (const version of [LEGACY_VERSION, LEGACY_VERSION_NEWER]) {
    it(`initialize ${version} → 200, no Mcp-Session-Id, echoed protocolVersion, identity name + package version`, async () => {
      const res = await mcp(legacyInit(version));
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeNull();
      const r = await readJsonRpc<InitResult>(res);
      expect(r.error).toBeUndefined();
      expect(r.result?.protocolVersion).toBe(version);
      expect(r.result?.serverInfo.name).toBe(TEST_IDENTITY);
      expect(r.result?.serverInfo.version).toBe(pkg.version);
      expect(r.result?.capabilities.tools?.listChanged).toBe(true);
      expect(r.result?.instructions).toContain(TEST_IDENTITY);
    });
  }

  it("two initialize POSTs in a row both succeed — nothing is remembered between requests", async () => {
    const a = await mcp(legacyInit(LEGACY_VERSION));
    const b = await mcp(legacyInit(LEGACY_VERSION));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get("mcp-session-id")).toBeNull();
    expect(b.headers.get("mcp-session-id")).toBeNull();
  });

  it("tools/list without a session → the 15 default built-ins, sorted by name", async () => {
    expect(await toolNames()).toEqual(DEFAULT_VISIBLE_TOOLS);
  });

  it("tools/list is deterministic across requests", async () => {
    const first = await toolNames();
    const second = await toolNames();
    expect(second).toEqual(first);
    expect(first).toEqual([...first].sort());
  });

  it("GET /mcp and DELETE /mcp → 405 (no SSE stream, no session to delete)", async () => {
    const get = await mcp(undefined, { method: "GET" });
    expect(get.status).toBe(405);
    const del = await mcp(undefined, { method: "DELETE" });
    expect(del.status).toBe(405);
  });

  it("/mcp/other → 404 (the route is exactly /mcp)", async () => {
    const { accessToken } = await oauthDance({ port: 3210 });
    const res = await mcp(rpc("tools/list"), { token: accessToken, url: `${BASE}/mcp/other` });
    expect(res.status).toBe(404);
  });
});

describe("stateless /mcp — modern lane (2026-07-28)", () => {
  it("server/discover → 200 with tools.listChanged === true and a private, zero-TTL cache hint", async () => {
    const res = await modern("server/discover");
    expect(res.status).toBe(200);
    const r = await readJsonRpc<{ supportedVersions: string[]; capabilities: { tools?: { listChanged?: boolean } }; ttlMs?: number; cacheScope?: string }>(res);
    expect(r.error).toBeUndefined();
    expect(r.result?.supportedVersions).toContain(MODERN_VERSION);
    expect(r.result?.capabilities.tools?.listChanged).toBe(true);
    expect(r.result?.ttlMs).toBe(0);
    expect(r.result?.cacheScope).toBe("private");
  });

  it("tools/list carries ttlMs 0 and cacheScope private and the same names as the legacy lane", async () => {
    const res = await modern("tools/list");
    expect(res.status).toBe(200);
    const r = await readJsonRpc<{ tools: { name: string }[]; ttlMs?: number; cacheScope?: string }>(res);
    expect(r.error).toBeUndefined();
    expect(r.result?.ttlMs).toBe(0);
    expect(r.result?.cacheScope).toBe("private");
    expect(r.result?.tools.map((t) => t.name).sort()).toEqual(await toolNames());
  });
});
