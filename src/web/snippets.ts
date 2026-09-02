// src/web/snippets.ts [E] — the install snippets and the public server description (§7.2, §15).
// Pure: no D1, no KV, no request state. Everything here is derived from the resolved catalog, the identity
// and the request origin, so the landing page, /api/info, /health and the `server_info` tool all agree.
import { REFRESH_HINT } from "../mcp/result";
import { VERSION } from "../version";
import type { Identity, RequestScope, ResolvedCatalog, ServerInfoPayload, Snippets } from "../types";

/** GitHub repo the Deploy button and the plugin marketplace point at. */
export const MARKETPLACE_REPO = "Soul-Brews-Studio/higher-order-mcp";
/** `/plugin install <id>` — plugin name `homcp` in marketplace `homcp` (.claude-plugin/marketplace.json). */
export const PLUGIN_ID = "homcp@homcp";
/** claude.ai connector settings page; `?modal=add-custom-connector&connectorName=&connectorUrl=` prefills the modal. */
export const CLAUDE_AI_CONNECTORS_URL = "https://claude.ai/customize/connectors";
/** The modern MCP protocol lane this server speaks (agents 0.22.0 / server 2.0.0). */
export const MODERN_PROTOCOL = "2026-07-28" as const;
/** Client key the public web pages resolve the catalog with (no client overrides are ever stored under it). */
export const WEB_CLIENT_KEY = "web";

/** The part of a RequestScope the web surfaces need. A full RequestScope satisfies it; web routes may pass `{ origin, env }`. */
export type WebScope = Pick<RequestScope, "origin" | "env">;

export function mcpEndpoint(origin: string): string {
  return `${origin}/mcp`;
}

/** claude.ai prefill link (§15.2): opens "Add custom connector" with Name and URL filled in. */
export function claudeAiPrefillLink(key: string, origin: string): string {
  return `${CLAUDE_AI_CONNECTORS_URL}?modal=add-custom-connector&connectorName=${encodeURIComponent(key)}&connectorUrl=${encodeURIComponent(mcpEndpoint(origin))}`;
}

/** The `.mcp.json` a project drops in to override the user-scope entry — identical to what `scripts/connect-mcp.sh project` writes. */
export function projectMcpJson(key: string, origin: string): string {
  return `{\n  "mcpServers": {\n    "${key}": { "type": "http", "url": "\${HOMCP_URL:-${mcpEndpoint(origin)}}" }\n  }\n}`;
}

/**
 * installSnippets(identity, origin) — §15.2 strings, verbatim. `key` (the Claude Code server key / claude.ai connector
 * name / Codex server name) defaults to the identity name, so the tool prefix reads mcp__<identity>__<tool>.
 */
export function installSnippets(identity: Pick<Identity, "name"> | string, origin: string): Snippets {
  const key = typeof identity === "string" ? identity : identity.name;
  const endpoint = mcpEndpoint(origin);
  return {
    claudeAdd: `claude mcp add --transport http --scope user ${key} ${endpoint}`,
    claudeLogin: `claude mcp login ${key}`,
    claudeToken: `claude mcp add --transport http --scope user ${key}-token ${endpoint} --header "Authorization: Bearer $HOMCP_TOKEN"`,
    codexAdd: `codex mcp add ${key} --url ${endpoint}`,
    codexLogin: `codex mcp login ${key}`,
    claudeAiLink: claudeAiPrefillLink(key, origin),
    projectMcpJson: projectMcpJson(key, origin),
    pluginInstall: `/plugin marketplace add ${MARKETPLACE_REPO}\n/plugin install ${PLUGIN_ID} --config server_url=${endpoint}`,
    curlHealth: `curl -s ${origin}/health`
  };
}

/**
 * CIMD status (§15): the provider only advertises client_id_metadata_document_supported when the Worker runs with
 * `global_fetch_strictly_public`. Runtimes that do not expose `Cloudflare.compatibilityFlags` are assumed to have it.
 */
export function cimdEnabled(): boolean {
  try {
    const cf = (globalThis as { Cloudflare?: { compatibilityFlags?: Record<string, boolean> } }).Cloudflare;
    if (!cf || !("compatibilityFlags" in cf) || !cf.compatibilityFlags) return true;
    return cf.compatibilityFlags.global_fetch_strictly_public === true;
  } catch {
    return true;
  }
}

/** Tool counters shared by /api/info, /health, the landing pills and `server_info`. */
export function toolCounts(catalog: ResolvedCatalog): ServerInfoPayload["tools"] {
  const all = [...catalog.tools.values()];
  const defined = all.filter((t) => t.kind !== "builtin");
  return {
    builtin: all.length - defined.length,
    defined: defined.length,
    promoted: defined.filter((t) => t.state.enabled && t.state.promoted).length,
    visible: catalog.visible.length,
    budget: catalog.budget.limit
  };
}

/** serverInfoPayload(catalog, scope, {cimd}) — the ServerInfoPayload served at /api/info and returned by `server_info` (§7, §15). */
export function serverInfoPayload(catalog: ResolvedCatalog, scope: WebScope, opts: { cimd: boolean }): ServerInfoPayload {
  const { identity } = catalog;
  return {
    name: identity.name,
    ...(identity.title ? { title: identity.title } : {}),
    ...(identity.description ? { description: identity.description } : {}),
    version: VERSION,
    endpoint: mcpEndpoint(scope.origin),
    auth: { oauth: { cimd: opts.cimd, dcr: true, pkce: ["S256"] }, staticToken: Boolean(scope.env.MCP_API_TOKEN) },
    protocol: { modern: MODERN_PROTOCOL, legacyLane: true },
    tools: toolCounts(catalog),
    catalogVersion: catalog.catalogVersion,
    schema: catalog.schemaMissing ? "missing" : "ok",
    snippets: installSnippets(identity, scope.origin),
    refreshHint: REFRESH_HINT
  };
}

/** /health body (§15): `{ ok, name, version, schema, catalogVersion, oauth:{cimd,dcr}, tools:{visible,total} }`. */
export interface HealthPayload {
  ok: true; name: string; version: string; schema: "ok" | "missing"; catalogVersion: number;
  oauth: { cimd: boolean; dcr: true }; tools: { visible: number; total: number };
}
export function healthPayload(catalog: ResolvedCatalog, opts: { cimd: boolean }): HealthPayload {
  return {
    ok: true,
    name: catalog.identity.name,
    version: VERSION,
    schema: catalog.schemaMissing ? "missing" : "ok",
    catalogVersion: catalog.catalogVersion,
    oauth: { cimd: opts.cimd, dcr: true },
    tools: { visible: catalog.visible.length, total: catalog.tools.size }
  };
}
