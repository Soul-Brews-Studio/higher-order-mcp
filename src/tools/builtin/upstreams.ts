// src/tools/builtin/upstreams.ts [C] — add_upstream, remove_upstream, list_upstreams, upstream_tools (§11; all hidden by
// default). Secrets never leave the server: auth_value is neither echoed nor loaded into list output; `bearer` is flagged.
import type { BuiltinSpec, ExecContext, ResolvedCatalog, ResolvedTool, UpstreamRow } from "../../types";
import { addUpstreamInput, listUpstreamsInput, removeUpstreamInput, upstreamToolsInput } from "../../mcp/schemas";
import { ok, fail, withRefreshHint } from "../../mcp/result";
import { deleteDef, deleteUpstream, getUpstreamFull, insertUpstream, isSchemaMissing, updateUpstreamCache } from "../../registry/db";
import { validateUpstreamName } from "../../registry/names";
import { notifyToolsChanged } from "../../mcp/handler";
import { checkHttpsUrl, describeUpstreamError, parseToolCache, redactUpstream, withUpstream, type CachedTool } from "../../registry/upstream";
import { refreshUpstreamTools, toCachedTool } from "../../registry/kinds/mcp";
import { SECRET_NAME_RE } from "../../util/template";

const MAX_HEADERS = 16;

/** Definitions of kind mcp that reference an upstream. */
export function referencingDefs(catalog: ResolvedCatalog, upstream: string): ResolvedTool[] {
  return [...catalog.tools.values()].filter((t) => t.kind === "mcp" && (t.spec as { upstream?: unknown } | undefined)?.upstream === upstream).sort((a, b) => (a.name < b.name ? -1 : 1));
}

function dbFail(e: unknown) {
  if (isSchemaMissing(e)) return fail("db_not_migrated", "The registry database is not migrated.", "Run `npm run db:migrate:remote`.");
  return undefined;
}

function hintsOf(t: CachedTool): string {
  const a = (t.annotations ?? {}) as Record<string, unknown>;
  const flags = [a.readOnlyHint ? "RO" : "", a.destructiveHint ? "D" : "", a.idempotentHint ? "I" : "", a.openWorldHint ? "OW" : ""].filter(Boolean);
  return flags.length ? ` [${flags.join(" ")}]` : "";
}

function exampleDefine(upstream: string, tool: CachedTool | undefined): Record<string, unknown> {
  const toolName = tool?.name ?? "<tool>";
  const name = `${upstream}_${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return { name, kind: "mcp", description: (tool?.description ?? `Proxy of ${toolName} on ${upstream}`).slice(0, 200), spec: { upstream, tool: toolName } };
}

// ---------------------------------------------------------------------------------------------------------------------
const addUpstream: BuiltinSpec = {
  name: "add_upstream",
  title: "Add upstream MCP server",
  description: "Register a remote MCP server (Streamable HTTP, https) so define_tool {kind:\"mcp\"} can proxy its tools. Connects once, caches its tool list and returns a ready define_tool example. auth.kind \"secret\" reads HOMCP_SECRET_<value> from the environment (preferred); \"bearer\" stores the token in D1.",
  inputSchema: addUpstreamInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  hiddenByDefault: true,
  async handler(args, exec: ExecContext) {
    const { name, url, auth, headers } = args as { name: string; url: string; auth?: { kind: "none" | "bearer" | "secret"; value?: string }; headers?: Record<string, string> };
    const nameError = validateUpstreamName(name);
    if (nameError) return fail("invalid_name", nameError, "Upstream names: ^[a-z][a-z0-9_-]{0,31}$.");
    if (exec.catalog.schemaMissing) return fail("db_not_migrated", "The registry database is not migrated.", "Run `npm run db:migrate:remote`.");
    if (exec.catalog.upstreams.some((u) => u.name === name)) return fail("name_taken", `Upstream '${name}' already exists.`, "remove_upstream first, or pick another name.");
    const checked = checkHttpsUrl(url);
    if ("error" in checked) return fail("spec_invalid", `url: ${checked.error}.`, "Upstreams are https:// MCP endpoints on public DNS names, e.g. https://example.workers.dev/mcp.");
    const kind = auth?.kind ?? "none";
    let authValue: string | null = null;
    if (kind === "bearer") {
      if (!auth?.value) return fail("spec_invalid", "auth.value is required for kind \"bearer\".");
      authValue = auth.value;
    } else if (kind === "secret") {
      if (!auth?.value || !SECRET_NAME_RE.test(auth.value)) return fail("spec_invalid", "auth.value must name a secret: ^[A-Z][A-Z0-9_]*$ (the token is read from HOMCP_SECRET_<value>).");
      if (!exec.scope.env[`HOMCP_SECRET_${auth.value}`]) return fail("spec_invalid", `Secret ${auth.value} is not set.`, `Run: wrangler secret put HOMCP_SECRET_${auth.value}`);
      authValue = auth.value;
    }
    const hdrs = headers ?? {};
    if (Object.keys(hdrs).length > MAX_HEADERS) return fail("spec_invalid", `At most ${MAX_HEADERS} headers.`);
    for (const k of Object.keys(hdrs)) if (!/^[A-Za-z0-9-]+$/.test(k)) return fail("spec_invalid", `Header name '${k}' is not valid.`);
    const now = new Date().toISOString();
    const row: UpstreamRow = { name, url: checked.url.toString(), auth_kind: kind, auth_value: authValue, headers: JSON.stringify(hdrs), server_info: null, tool_cache: null, cached_at: null, created_by: exec.scope.principal.clientKey, created_at: now };

    let tools: CachedTool[]; let serverInfo: unknown;
    try {
      ({ tools, serverInfo } = await withUpstream(exec.scope, row, async (c) => {
        const r = await c.listTools();
        return { tools: r.tools.map(toCachedTool), serverInfo: c.getServerVersion() ?? null };
      }));
    } catch (e) {
      return fail("upstream_unreachable", `Could not connect to ${checked.url.host}: ${describeUpstreamError(e)}`, "Check the URL (must end at the MCP endpoint, usually /mcp) and the auth. Nothing was stored.");
    }
    row.server_info = JSON.stringify(serverInfo); row.tool_cache = JSON.stringify(tools); row.cached_at = now;
    try {
      await insertUpstream(exec.scope.env.DB, row, exec.scope.principal.clientKey);
      await updateUpstreamCache(exec.scope.env.DB, name, row.server_info, row.tool_cache);
    } catch (e) { return dbFail(e) ?? fail("internal", `Could not store upstream '${name}': ${String(e).slice(0, 200)}`); }

    const names = tools.map((t) => t.name);
    const info = serverInfo && typeof serverInfo === "object" ? (serverInfo as { name?: string; version?: string }) : {};
    const example = exampleDefine(name, tools[0]);
    const lines = [
      `Added upstream \`${name}\` → ${checked.url.host} (${info.name ?? "unnamed server"}${info.version ? ` v${info.version}` : ""}), auth: ${kind}.`,
      `${names.length} tools: ${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}`,
      "",
      "Proxy one of them:",
      `define_tool ${JSON.stringify(example)}`,
      "",
      "Then call_tool it, or promote_tool to list it. upstream_tools {upstream} shows schemas."
    ];
    if (kind === "bearer") lines.push("", "Note: bearer tokens are stored in plaintext in D1. Prefer auth {kind:\"secret\", value:\"NAME\"} with `wrangler secret put HOMCP_SECRET_NAME`.");
    return ok(lines.join("\n"), { name, url: row.url, auth_kind: kind, serverInfo: serverInfo ?? null, tools: names, example, plaintextBearer: kind === "bearer" });
  }
};

// ---------------------------------------------------------------------------------------------------------------------
const removeUpstream: BuiltinSpec = {
  name: "remove_upstream",
  title: "Remove upstream MCP server",
  description: "Delete a registered upstream. Refuses with upstream_in_use while mcp definitions reference it unless force:true, which deletes those definitions too.",
  inputSchema: removeUpstreamInput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  meta: { "anthropic/requiresUserInteraction": true },
  hiddenByDefault: true,
  async handler(args, exec: ExecContext) {
    const { name, force } = args as { name: string; force: boolean };
    if (exec.catalog.schemaMissing) return fail("db_not_migrated", "The registry database is not migrated.", "Run `npm run db:migrate:remote`.");
    if (!exec.catalog.upstreams.some((u) => u.name === name)) return fail("unknown_upstream", `No upstream named '${name}'.`, "list_upstreams shows the registered ones.");
    const refs = referencingDefs(exec.catalog, name);
    if (refs.length && !force) return fail("upstream_in_use", `Upstream '${name}' is used by ${refs.length} definition(s): ${refs.map((t) => t.name).join(", ")}.`, "remove_tool them first, or pass force:true to delete them together with the upstream.", { definitions: refs.map((t) => t.name) });
    const actor = exec.scope.principal.clientKey;
    try {
      for (const t of refs) await deleteDef(exec.scope.env.DB, t.name, actor);
      await deleteUpstream(exec.scope.env.DB, name, actor);
    } catch (e) { return dbFail(e) ?? fail("internal", `Could not remove upstream '${name}': ${String(e).slice(0, 200)}`); }
    if (refs.length) notifyToolsChanged();
    const text = refs.length ? `Removed upstream \`${name}\` and ${refs.length} definition(s): ${refs.map((t) => t.name).join(", ")}.` : `Removed upstream \`${name}\`.`;
    const result = ok(text, { name, removedDefinitions: refs.map((t) => t.name) });
    return refs.length ? withRefreshHint(result) : result;
  }
};

// ---------------------------------------------------------------------------------------------------------------------
const listUpstreams: BuiltinSpec = {
  name: "list_upstreams",
  title: "List upstream MCP servers",
  description: "Registered upstream MCP servers with auth kind, cached tool count, cache time and the mcp definitions that reference each. Tokens are never shown.",
  inputSchema: listUpstreamsInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  hiddenByDefault: true,
  async handler(_args, exec: ExecContext) {
    if (exec.catalog.schemaMissing) return fail("db_not_migrated", "The registry database is not migrated.", "Run `npm run db:migrate:remote`.");
    const rows: Array<Record<string, unknown>> = [];
    for (const u of exec.catalog.upstreams) {
      let full: UpstreamRow | null = null;
      try { full = await getUpstreamFull(exec.scope.env.DB, u.name); }
      catch (e) { const f = dbFail(e); if (f) return f; }
      const red = redactUpstream(full ?? u);
      const definitions = referencingDefs(exec.catalog, u.name).map((t) => t.name);
      rows.push({ ...red, definitions });
    }
    if (!rows.length) return ok("No upstreams. add_upstream {name, url, auth?} registers one.", { upstreams: [] });
    const lines = rows.map((r) => `${r.name} · ${r.url} · auth ${r.auth_kind} · ${r.tool_count ?? "?"} tools cached ${r.cached_at ?? "never"} · used by ${(r.definitions as string[]).length ? (r.definitions as string[]).join(", ") : "nothing"}`);
    return ok(`${rows.length} upstream(s)\n${lines.join("\n")}`, { upstreams: rows });
  }
};

// ---------------------------------------------------------------------------------------------------------------------
const upstreamToolsTool: BuiltinSpec = {
  name: "upstream_tools",
  title: "Upstream tools",
  description: "Tools an upstream exposes, from the cache or live with refresh:true (updates the cache). Optional substring filter on name/description. Never registers anything; use define_tool {kind:\"mcp\"} to proxy one.",
  inputSchema: upstreamToolsInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  hiddenByDefault: true,
  async handler(args, exec: ExecContext) {
    const { upstream, refresh, filter } = args as { upstream: string; refresh: boolean; filter?: string };
    if (exec.catalog.schemaMissing) return fail("db_not_migrated", "The registry database is not migrated.", "Run `npm run db:migrate:remote`.");
    let full: UpstreamRow | null;
    try { full = await getUpstreamFull(exec.scope.env.DB, upstream); }
    catch (e) { return dbFail(e) ?? fail("internal", String(e).slice(0, 200)); }
    if (!full) return fail("unknown_upstream", `No upstream named '${upstream}'.`, "list_upstreams shows the registered ones.");
    let tools = refresh ? null : parseToolCache(full.tool_cache);
    let source: "cache" | "live" = "cache";
    let cachedAt = full.cached_at;
    if (!tools) {
      try { tools = (await refreshUpstreamTools(exec.scope, full)).tools; source = "live"; cachedAt = new Date().toISOString(); }
      catch (e) { return fail("upstream_unreachable", `Upstream '${upstream}' could not be reached: ${describeUpstreamError(e)}`, "Check list_upstreams and the upstream's auth."); }
    }
    const needle = filter?.toLowerCase().trim();
    const shown = needle ? tools.filter((t) => t.name.toLowerCase().includes(needle) || (t.description ?? "").toLowerCase().includes(needle) || (t.title ?? "").toLowerCase().includes(needle)) : tools;
    const lines = shown.map((t) => `${t.name}${t.title && t.title !== t.name ? ` — ${t.title}` : ""}${hintsOf(t)}: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    const head = `${shown.length}${needle ? ` of ${tools.length}` : ""} tool(s) on \`${upstream}\` (${source}${cachedAt ? `, cached ${cachedAt}` : ""})`;
    const example = exampleDefine(upstream, shown[0] ?? tools[0]);
    return ok(`${head}\n${lines.join("\n")}\n\nProxy one: define_tool ${JSON.stringify(example)}`, { upstream, source, cached_at: cachedAt, total: tools.length, tools: shown, example });
  }
};

export const upstreamTools: BuiltinSpec[] = [addUpstream, removeUpstream, listUpstreams, upstreamToolsTool];
