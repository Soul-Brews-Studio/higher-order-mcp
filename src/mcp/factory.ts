// src/mcp/factory.ts [A] — one McpServer per request (§8.4): snapshot → identity → catalog → registerTool for every
// enabled tool in name order (deterministic tools/list); unpromoted tools are registered then disable()d so they stay
// reachable through call_tool but absent from tools/list. Schema missing ⇒ built-in-only catalog, never runtime DDL.
import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { VERSION } from "../version";
import { resolveIdentity } from "../identity";
import { loadSnapshot, emptySnapshot } from "../registry/db";
import { resolveCatalog } from "../registry/resolve";
import { invoke } from "../registry/dispatch";
import { BUILTINS } from "../tools/builtin";
import { SchemaMissingError, type RequestScope } from "../types";
export async function buildServer(mcpCtx: McpRequestContext, scope: RequestScope): Promise<McpServer> {
  scope.era = mcpCtx.era;
  let snapshot;
  try { snapshot = await loadSnapshot(scope.env.DB, scope.principal.clientKey); }
  catch (e) { if (!(e instanceof SchemaMissingError)) throw e; console.error("registry unavailable: run `npm run db:migrate:remote`"); snapshot = emptySnapshot(); }
  const identity = resolveIdentity(snapshot.settings, scope.env, scope.host);
  const catalog = resolveCatalog(BUILTINS, snapshot, scope.principal, identity);
  const server = new McpServer(
    { name: identity.name, version: VERSION, ...(identity.title ? { title: identity.title } : {}) },
    { instructions: identity.instructions, cacheHints: { "tools/list": { ttlMs: 0, cacheScope: "private" }, "server/discover": { ttlMs: 0, cacheScope: "private" } } }
  );
  const entries = [...catalog.tools.values()].filter((t) => t.state.enabled).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const tool of entries) {
    const reg = server.registerTool(tool.name,
      { title: tool.state.title, description: tool.state.description, inputSchema: tool.inputSchema, annotations: tool.annotations, ...(tool.meta ? { _meta: tool.meta } : {}) },
      (args) => invoke(scope, catalog, tool.name, args as Record<string, unknown>, { depth: 0 }));   // StandardSchemaWithJSON output is `unknown`; every schema here is a z.object / JSON object schema
    if (!tool.state.promoted) reg.disable();   // hidden from tools/list; direct tools/call → SDK "Tool X disabled"; reachable via call_tool
  }
  return server;
}
