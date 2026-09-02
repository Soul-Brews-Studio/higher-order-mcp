// test/web.test.ts [E] — §18 web row. Two halves: pure rendering (snippets + landing on a fabricated catalog, no database)
// and the live routes through SELF.fetch (landing, /health, /api/info == server_info, /sse 410, 404 JSON).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REFRESH_HINT } from "../src/mcp/result";
import { VERSION } from "../src/version";
import { renderLanding } from "../src/web/landing";
import { claudeAiPrefillLink, healthPayload, installSnippets, projectMcpJson, serverInfoPayload, toolCounts, type WebScope } from "../src/web/snippets";
import type { Env, Kind, ResolvedCatalog, ResolvedTool, ServerInfoPayload, ToolState } from "../src/types";
import { BASE, DEFAULT_VISIBLE_TOOLS, TEST_IDENTITY, TEST_PASSPHRASE, TEST_TOKEN, callTool, get, json, structuredOf } from "./helpers";

const EXACT_ADD = `claude mcp add --transport http --scope user ${TEST_IDENTITY} ${BASE}/mcp`;
const EXACT_LOGIN = `claude mcp login ${TEST_IDENTITY}`;
const EXACT_LINK = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${TEST_IDENTITY}&connectorUrl=https%3A%2F%2Fhomcp.test%2Fmcp`;
const PROJECT_URL = "${HOMCP_URL:-https://homcp.test/mcp}";

// ---- a fabricated catalog: enough shape for the pure renderers ------------------------------------------------------
function fakeTool(name: string, kind: Kind, state: Partial<ToolState> = {}, opts: { protected?: boolean } = {}): ResolvedTool {
  const schema = z.object({});
  return {
    name, kind, protected: !!opts.protected,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: schema, inputSchemaJson: { type: "object", properties: {} },
    state: { enabled: true, promoted: true, title: name, description: `${name} description`, decidedBy: { enabled: "builtin", promoted: "builtin" }, deployDisabled: false, ...state }
  };
}
function fakeCatalog(over: Partial<ResolvedCatalog> = {}): ResolvedCatalog {
  const tools = new Map<string, ResolvedTool>();
  for (const n of ["list_tools", "describe_tool", "call_tool"]) tools.set(n, fakeTool(n, "builtin", {}, { protected: true }));
  tools.set("remember", fakeTool("remember", "builtin"));
  tools.set("set_identity", fakeTool("set_identity", "builtin", { promoted: false }));
  tools.set("standup", fakeTool("standup", "template", { promoted: true, decidedBy: { enabled: "builtin", promoted: "deploy" } }));
  tools.set("hidden_def", fakeTool("hidden_def", "http", { promoted: false }));
  tools.set("dead_def", fakeTool("dead_def", "compose", { enabled: false, promoted: true, deployDisabled: true }));
  const visible = [...tools.values()].filter((t) => t.state.enabled && t.state.promoted).sort((a, b) => a.name.localeCompare(b.name));
  return {
    tools, visible,
    budget: { limit: 12, usedDeploy: 1, usedClient: 0 },
    identity: { name: TEST_IDENTITY, instructions: "test instructions", source: "var" },
    principal: { userId: "owner", via: "oauth", clientKey: "web", scopes: [] },
    catalogVersion: 7, upstreams: [], schemaMissing: false, warnings: [],
    ...over
  };
}
const fakeScope = (env: Partial<Env> = {}): WebScope => ({ origin: BASE, env: { MCP_API_TOKEN: TEST_TOKEN, OWNER_PASSPHRASE: TEST_PASSPHRASE, ...env } as Env });
const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const testid = (html: string, id: string) => new RegExp(`data-testid="${id}"`).test(html);

describe("installSnippets (§15.2 strings)", () => {
  const s = installSnippets({ name: TEST_IDENTITY }, BASE);
  it("claude code lines are exact", () => {
    expect(s.claudeAdd).toBe(EXACT_ADD);
    expect(s.claudeLogin).toBe(EXACT_LOGIN);
    expect(s.claudeToken).toBe(`claude mcp add --transport http --scope user ${TEST_IDENTITY}-token ${BASE}/mcp --header "Authorization: Bearer $HOMCP_TOKEN"`);
  });
  it("codex, curl and plugin lines", () => {
    expect(s.codexAdd).toBe(`codex mcp add ${TEST_IDENTITY} --url ${BASE}/mcp`);
    expect(s.codexLogin).toBe(`codex mcp login ${TEST_IDENTITY}`);
    expect(s.curlHealth).toBe(`curl -s ${BASE}/health`);
    expect(s.pluginInstall).toBe(`/plugin marketplace add Soul-Brews-Studio/higher-order-mcp\n/plugin install homcp@homcp --config server_url=${BASE}/mcp`);
  });
  it("claude.ai prefill link encodes the endpoint", () => {
    expect(s.claudeAiLink).toBe(EXACT_LINK);
    expect(claudeAiPrefillLink("a b", "https://x.example")).toContain("connectorName=a%20b");
  });
  it("project .mcp.json is valid JSON with the ${HOMCP_URL:-…} fallback and the identity as key", () => {
    const parsed = JSON.parse(s.projectMcpJson) as { mcpServers: Record<string, { type: string; url: string }> };
    expect(parsed.mcpServers[TEST_IDENTITY]).toEqual({ type: "http", url: PROJECT_URL });
    expect(projectMcpJson("k", "https://o.example")).toBe(`{\n  "mcpServers": {\n    "k": { "type": "http", "url": "\${HOMCP_URL:-https://o.example/mcp}" }\n  }\n}`);
  });
  it("accepts a plain string key", () => {
    expect(installSnippets("thor", BASE).claudeAdd).toBe(`claude mcp add --transport http --scope user thor ${BASE}/mcp`);
  });
});

describe("serverInfoPayload / healthPayload / toolCounts", () => {
  it("counts built-ins, definitions, promoted and visible tools", () => {
    expect(toolCounts(fakeCatalog())).toEqual({ builtin: 5, defined: 3, promoted: 1, visible: 5, budget: 12 });
  });
  it("payload shape (§7 ServerInfoPayload)", () => {
    const p = serverInfoPayload(fakeCatalog(), fakeScope(), { cimd: true });
    expect(p).toMatchObject({
      name: TEST_IDENTITY, version: VERSION, endpoint: `${BASE}/mcp`,
      auth: { oauth: { cimd: true, dcr: true, pkce: ["S256"] }, staticToken: true },
      protocol: { modern: "2026-07-28", legacyLane: true },
      tools: { builtin: 5, defined: 3, promoted: 1, visible: 5, budget: 12 },
      catalogVersion: 7, schema: "ok", refreshHint: REFRESH_HINT
    });
    expect(p.snippets.claudeAdd).toBe(EXACT_ADD);
    expect(p).not.toHaveProperty("title");
    expect(p).not.toHaveProperty("description");
  });
  it("reflects missing schema, absent static token, title and description", () => {
    const p = serverInfoPayload(fakeCatalog({ schemaMissing: true, identity: { name: "n", title: "T", description: "D", instructions: "", source: "default" } }), fakeScope({ MCP_API_TOKEN: undefined }), { cimd: false });
    expect(p.schema).toBe("missing");
    expect(p.auth.staticToken).toBe(false);
    expect(p.auth.oauth.cimd).toBe(false);
    expect(p.title).toBe("T");
    expect(p.description).toBe("D");
  });
  it("health payload", () => {
    expect(healthPayload(fakeCatalog(), { cimd: true })).toEqual({ ok: true, name: TEST_IDENTITY, version: VERSION, schema: "ok", catalogVersion: 7, oauth: { cimd: true, dcr: true }, tools: { visible: 5, total: 8 } });
  });
});

describe("renderLanding (pure)", () => {
  const html = renderLanding(fakeCatalog(), fakeScope(), { cimd: true });
  it("is a complete document with the identity as title", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<title>${TEST_IDENTITY} — higher-order MCP server</title>`);
    expect(html).toContain(`data-testid="identity-name">${TEST_IDENTITY}<`);
    expect(html).toContain(`v${VERSION}`);
  });
  it("carries every §15.2 snippet with its data-testid", () => {
    for (const id of ["claude-add", "claude-login", "claudeai-link", "claudeai-url", "codex-add", "project-mcp-json", "claude-token", "plugin-install", "curl-health", "owner-link"]) expect(testid(html, id), id).toBe(true);
    expect(html).toContain(EXACT_ADD);
    expect(html).toContain(EXACT_LOGIN);
    expect(decodeEntities(html)).toContain(`href="${EXACT_LINK}"`);
    expect(html).toContain("connectorUrl=https%3A%2F%2Fhomcp.test%2Fmcp");
    expect(html).toContain(`codex mcp add ${TEST_IDENTITY} --url ${BASE}/mcp &amp;&amp; codex mcp login ${TEST_IDENTITY}`);
    expect(decodeEntities(html)).toContain(`"${TEST_IDENTITY}": { "type": "http", "url": "${PROJECT_URL}" }`);
    expect(decodeEntities(html)).toContain(`--header "Authorization: Bearer $HOMCP_TOKEN"`);
    expect(html).toContain("/plugin install homcp@homcp --config server_url=");
  });
  it("shows the pills, the three names, the endpoints and the refresh hint", () => {
    expect(html).toContain("CIMD + DCR");
    expect(html).toContain("5 listed · 3 defined · budget 1/12");
    expect(html).toContain("Rename this server");
    expect(html).toContain(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(html).toContain(`${BASE}/oauth/register`);
    expect(decodeEntities(html)).toContain(REFRESH_HINT);
    expect(html).toContain("catalog_version 7");
  });
  it("never leaks secrets and escapes user-controlled identity fields", () => {
    expect(html).not.toContain(TEST_PASSPHRASE);
    expect(html).not.toContain(TEST_TOKEN);
    const spicy = renderLanding(fakeCatalog({ identity: { name: "x", title: "<b>bold</b>", description: "a & b", instructions: "", source: "settings" } }), fakeScope(), { cimd: true });
    expect(spicy).not.toContain("<b>bold</b>");
    expect(spicy).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(spicy).toContain("a &amp; b");
  });
  it("yellow box only when the schema is missing; DCR-only pill when CIMD is off", () => {
    expect(testid(html, "schema-missing")).toBe(false);
    const missing = renderLanding(fakeCatalog({ schemaMissing: true }), fakeScope(), { cimd: false });
    expect(testid(missing, "schema-missing")).toBe(true);
    expect(missing).toContain("npm run db:migrate:remote");
    expect(missing).toContain("OAuth: <b>DCR</b>");
  });
  it("shows client-promoted slots in the budget pill", () => {
    const h = renderLanding(fakeCatalog({ budget: { limit: 12, usedDeploy: 3, usedClient: 2 } }), fakeScope(), { cimd: true });
    expect(h).toContain("budget 3/12 (+2 client)");
  });
});

describe("web routes (through the Worker)", () => {
  it("GET / is the landing page with the exact install lines and no secrets", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    const html = await res.text();
    expect(html).toContain(EXACT_ADD);
    expect(html).toContain(EXACT_LOGIN);
    expect(html).toContain("connectorUrl=https%3A%2F%2Fhomcp.test%2Fmcp");
    expect(decodeEntities(html)).toContain(PROJECT_URL);
    for (const id of ["claude-add", "claude-login", "claudeai-link", "codex-add", "project-mcp-json", "claude-token", "plugin-install"]) expect(testid(html, id), id).toBe(true);
    expect(html).not.toContain(TEST_PASSPHRASE);
    expect(html).not.toContain(TEST_TOKEN);
    expect(html).not.toContain("s3cret");
    expect(testid(html, "schema-missing")).toBe(false);
  });

  it("GET /health has the §15 shape", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; name: string; version: string; schema: string; catalogVersion: number; oauth: { cimd: boolean; dcr: boolean }; tools: { visible: number; total: number } }>(res);
    expect(body.ok).toBe(true);
    expect(body.name).toBe(TEST_IDENTITY);
    expect(body.version).toBe(VERSION);
    expect(body.schema).toBe("ok");
    expect(typeof body.catalogVersion).toBe("number");
    expect(body.oauth.dcr).toBe(true);
    expect(typeof body.oauth.cimd).toBe("boolean");
    expect(body.tools.visible).toBe(DEFAULT_VISIBLE_TOOLS.length);
    expect(body.tools.total).toBe(22);
  });

  it("GET /api/info equals the server_info tool payload", async () => {
    const info = await json<ServerInfoPayload>(await get("/api/info"));
    expect(info.name).toBe(TEST_IDENTITY);
    expect(info.endpoint).toBe(`${BASE}/mcp`);
    expect(info.snippets.claudeAdd).toBe(EXACT_ADD);
    expect(info.snippets.claudeAiLink).toBe(EXACT_LINK);
    expect(info.auth.staticToken).toBe(true);
    expect(info.protocol).toEqual({ modern: "2026-07-28", legacyLane: true });
    expect(info.tools).toMatchObject({ builtin: 22, defined: 0, promoted: 0, visible: 15, budget: 12 });
    expect(info.refreshHint).toBe(REFRESH_HINT);
    const viaTool = structuredOf<Record<string, unknown>>(await callTool("server_info"));
    for (const key of ["name", "version", "endpoint", "auth", "protocol", "tools", "catalogVersion", "schema", "snippets", "refreshHint"] as const) {
      expect(viaTool[key], key).toEqual(info[key]);
    }
  });

  it("GET /sse is retired with 410 problem+json and a Link to /mcp", async () => {
    const res = await get("/sse");
    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("link")).toBe('</mcp>; rel="alternate"');
    const body = await json<{ title: string; detail: string }>(res);
    expect(body.title).toBe("SSE transport retired");
    expect(body.detail).toContain("/mcp");
  });

  it("unknown paths answer 404 JSON", async () => {
    const res = await get("/nope/nothing");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: "not_found" });
  });
});
