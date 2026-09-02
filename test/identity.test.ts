// test/identity.test.ts [A] — §18 "identity" row: the three-way name precedence (D1 setting → var → host label → homcp),
// host-label edge cases, the identity-name validator, and a live rename that shows up in initialize, the landing page
// and catalog_version without a redeploy.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_INSTRUCTIONS, IDENTITY_NAME_RE, hostLabel, resolveIdentity, validateIdentityName } from "../src/identity";
import type { Env } from "../src/types";
import { BASE, LEGACY_VERSION, TEST_IDENTITY, callTool, errorOf, get, json, legacyInit, mcp, readJsonRpc } from "./helpers";

const envWith = (name?: string): Env => ({ MCP_SERVER_NAME: name } as unknown as Env);
const HOST = "thor-memory.buildwithoracle.com";

describe("resolveIdentity precedence", () => {
  it("D1 setting wins over the var and the host", () => {
    const id = resolveIdentity({ identity_name: "odin-memory" }, envWith("thor-memory"), HOST);
    expect(id).toMatchObject({ name: "odin-memory", source: "settings" });
  });
  it("a non-empty var wins over the host label", () => {
    expect(resolveIdentity({}, envWith("thor-memory"), "homcp.laris.workers.dev")).toMatchObject({ name: "thor-memory", source: "var" });
  });
  it("an empty (or whitespace) var falls through to the host label", () => {
    expect(resolveIdentity({}, envWith(""), HOST)).toMatchObject({ name: "thor-memory", source: "host" });
    expect(resolveIdentity({}, envWith("   "), HOST)).toMatchObject({ name: "thor-memory", source: "host" });
    expect(resolveIdentity({}, envWith(undefined), HOST)).toMatchObject({ name: "thor-memory", source: "host" });
  });
  it("falls back to homcp when nothing usable exists", () => {
    expect(resolveIdentity({}, envWith(""), "localhost:8787")).toMatchObject({ name: "homcp", source: "default" });
    expect(resolveIdentity({}, envWith(""), "127.0.0.1")).toMatchObject({ name: "homcp", source: "default" });
  });
  it("an invalid setting or var is ignored rather than used", () => {
    expect(resolveIdentity({ identity_name: "Thor Memory" }, envWith("a.b"), HOST)).toMatchObject({ name: "thor-memory", source: "host" });
  });
  it("title/description/instructions come from settings, instructions default to the explainer and are capped at 1000 chars", () => {
    const plain = resolveIdentity({}, envWith("x"), HOST);
    expect(plain.title).toBeUndefined();
    expect(plain.description).toBeUndefined();
    expect(plain.instructions).toBe(DEFAULT_INSTRUCTIONS("x"));
    const rich = resolveIdentity({ identity_title: "Thor", identity_description: "memory", identity_instructions: "i".repeat(2000) }, envWith("x"), HOST);
    expect(rich).toMatchObject({ title: "Thor", description: "memory" });
    expect(rich.instructions).toHaveLength(1000);
  });
});

describe("hostLabel", () => {
  it("takes the first DNS label, lowercased, without the port", () => {
    expect(hostLabel("thor-memory.buildwithoracle.com")).toBe("thor-memory");
    expect(hostLabel("Homcp.Laris.workers.dev:443")).toBe("homcp");
    expect(hostLabel("odin_memory.example.com")).toBe("odin_memory");
  });
  it("skips localhost, IPv4, IPv6 and empty hosts", () => {
    expect(hostLabel("localhost")).toBeNull();
    expect(hostLabel("localhost:8787")).toBeNull();
    expect(hostLabel("127.0.0.1")).toBeNull();
    expect(hostLabel("[::1]:8787")).toBeNull();
    expect(hostLabel("")).toBeNull();
  });
  it("sanitizes odd labels and rejects those that end up empty or too long", () => {
    expect(hostLabel("my.app.example.com")).toBe("my");
    expect(hostLabel("--weird.example.com")).toBe("weird");
    expect(hostLabel("a".repeat(40) + ".example.com")).toBe("a".repeat(32));
    expect(hostLabel("---.example.com")).toBeNull();
  });
});

describe("validateIdentityName", () => {
  it("accepts what `claude mcp add` accepts", () => {
    for (const ok of ["homcp", "thor-memory", "odin_memory", "a", "A1", "x".repeat(32)]) {
      expect(validateIdentityName(ok)).toBeNull();
      expect(IDENTITY_NAME_RE.test(ok)).toBe(true);
    }
  });
  it("rejects spaces, dots, leading punctuation, empty and 33 chars", () => {
    expect(validateIdentityName("Thor Memory")).not.toBeNull();
    expect(validateIdentityName("a.b")).not.toBeNull();
    expect(validateIdentityName("-thor")).not.toBeNull();
    expect(validateIdentityName("")).not.toBeNull();
    expect(validateIdentityName("x".repeat(33))).not.toBeNull();
  });
});

async function serverName(): Promise<string> {
  const r = await readJsonRpc<{ serverInfo: { name: string } }>(await mcp(legacyInit(LEGACY_VERSION)));
  if (r.error) throw new Error(r.error.message);
  return r.result!.serverInfo.name;
}
async function health(): Promise<{ name: string; catalogVersion: number }> {
  return json<{ name: string; catalogVersion: number }>(await get("/health"));
}

describe("rename without redeploy", () => {
  it("the test deployment identifies as the MCP_SERVER_NAME var", async () => {
    expect(await serverName()).toBe(TEST_IDENTITY);
    expect((await health()).name).toBe(TEST_IDENTITY);
    expect(await (await get("/")).text()).toContain(`claude mcp add --transport http --scope user ${TEST_IDENTITY} ${BASE}/mcp`);
  });

  it("a D1 identity_name setting overrides the var for initialize, /health and the landing snippets", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('identity_name', 'thor-memory')").run();
    expect(await serverName()).toBe("thor-memory");
    expect((await health()).name).toBe("thor-memory");
    const landing = await (await get("/")).text();
    expect(landing).toContain(`claude mcp add --transport http --scope user thor-memory ${BASE}/mcp`);
    expect(landing).toContain("claude mcp login thor-memory");
  });

  it("set_identity {name:\"thor-memory\"} renames live and bumps catalog_version", async () => {
    const before = await health();
    const r = await callTool("call_tool", { name: "set_identity", arguments: { name: "thor-memory" } });
    expect(errorOf(r)).toBeUndefined();
    expect(await serverName()).toBe("thor-memory");
    const after = await health();
    expect(after.name).toBe("thor-memory");
    expect(after.catalogVersion).toBe(before.catalogVersion + 1);
    expect(await (await get("/")).text()).toContain(`claude mcp add --transport http --scope user thor-memory ${BASE}/mcp`);
  });

  it("set_identity refuses an invalid name and leaves the identity alone", async () => {
    const before = await serverName();
    const r = await callTool("call_tool", { name: "set_identity", arguments: { name: "Thor Memory" } });
    expect(errorOf(r)).toBeDefined();
    expect(await serverName()).toBe(before);
  });
});
