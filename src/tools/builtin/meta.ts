// src/tools/builtin/meta.ts [B] — the tools that manage tools (§11): list_tools, describe_tool, call_tool, toggle_tool,
// promote_tool, demote_tool, remove_tool, override_tool. Every mutation: ONE db batch → notifyToolsChanged() → refresh hint.
// Shared helpers (guarded, reresolve, actorOf, …) are exported for forge.ts and identity.ts.
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { notifyToolsChanged } from "../../mcp/handler";
import { fail, ok, withRefreshHint } from "../../mcp/result";
import { callToolInput, demoteToolInput, describeToolInput, listToolsInput, overrideToolInput, promoteToolInput, removeToolInput, toggleToolInput } from "../../mcp/schemas";
import { deleteDef, deleteOverride, getUpstreamFull, isSchemaMissing, listOverridesFor, loadSnapshot, upsertOverride } from "../../registry/db";
import { invoke, nearest } from "../../registry/dispatch";
import { resolveCatalog } from "../../registry/resolve";
import type { BuiltinSpec, ExecContext, OverrideScope, ResolvedCatalog, ResolvedTool, ToolOverrideRow } from "../../types";

// ---------------------------------------------------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------------------------------------------------
export const PROTECTED_LIST = "list_tools, describe_tool, call_tool, toggle_tool, promote_tool, demote_tool";
export const REFRESH_TEXT = "Clients cache tool lists — refresh after this change.";

export function dbNotMigrated(): CallToolResult {
  return fail("db_not_migrated", "The registry database is not migrated.", "Run `npm run db:migrate:remote`.");
}
/** registry_events.actor / tool_defs.created_by: the client key ("token" for the static bearer, the consent label for OAuth). */
export function actorOf(exec: ExecContext): string { return exec.scope.principal.clientKey; }
export function claudeCodeName(identityName: string, tool: string): string { return `mcp__${identityName}__${tool}`; }
export function unknownTool(name: string, catalog: ResolvedCatalog): CallToolResult {
  return fail("unknown_tool", `No tool named '${name}'.`, `Nearest: ${nearest(name, catalog)}. Call list_tools to see every tool, including hidden ones.`);
}
export function protectedTool(name: string): CallToolResult {
  return fail("protected_tool", `'${name}' is protected: always on and always listed.`, `Protected tools: ${PROTECTED_LIST}.`);
}
/** The BuiltinSpec list the catalog was built from (avoids importing ./index, which imports this file). */
export function builtinsOf(catalog: ResolvedCatalog): BuiltinSpec[] {
  return [...catalog.tools.values()].flatMap((t) => (t.builtin ? [t.builtin] : []));
}
/** Runs a handler body; a missing schema becomes fail("db_not_migrated") instead of an exception. */
export async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try { return await fn(); }
  catch (e) { if (isSchemaMissing(e)) return dbNotMigrated(); throw e; }
}
/** Fresh snapshot + resolve after a mutation (or for another client key's view). Identity is unchanged by tool mutations. */
export async function reresolve(exec: ExecContext, clientKey: string = exec.scope.principal.clientKey): Promise<ResolvedCatalog> {
  const snap = await loadSnapshot(exec.scope.env.DB, clientKey);
  const principal = clientKey === exec.scope.principal.clientKey ? exec.scope.principal : { ...exec.scope.principal, clientKey };
  return resolveCatalog(builtinsOf(exec.catalog), snap, principal, exec.catalog.identity);
}
/** The catalog as seen by `key` — the caller's own catalog when it is the caller's key. */
async function viewFor(exec: ExecContext, scope: OverrideScope, key: string): Promise<ResolvedCatalog> {
  return scope === "client" && key !== exec.scope.principal.clientKey ? reresolve(exec, key) : exec.catalog;
}
function keyFor(exec: ExecContext, scope: OverrideScope, client: string | undefined): string {
  return scope === "client" ? (client ?? exec.scope.principal.clientKey) : "";
}
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const onoff = (b: boolean) => (b ? "on" : "off");
const yn = (b: boolean) => (b ? "yes" : "no");
const isVisible = (t: ResolvedTool) => t.state.enabled && t.state.promoted;
const originOf = (t: ResolvedTool) => (t.kind === "builtin" ? "builtin" : "defined");
const promotedAt = (catalog: ResolvedCatalog, scope: OverrideScope) =>
  [...catalog.tools.values()].filter((t) => t.kind !== "builtin" && t.state.promoted && t.state.decidedBy.promoted === scope).map((t) => t.name).sort();

// ---------------------------------------------------------------------------------------------------------------------
// redaction (describe_tool)
// ---------------------------------------------------------------------------------------------------------------------
const SENSITIVE_KEY = /authorization|bearer|token|secret|api[-_]?key|password|passphrase|cookie/i;
const KEEP_SECRET_REF = "{{secret:";
/** Replaces credential-looking values with ••• while keeping `{{secret:NAME}}` references (env names, not secrets). */
export function redactSpec(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(key)) return value.includes(KEEP_SECRET_REF) ? value : "•••";
    return value
      .replace(/\b(Bearer|Basic)\s+(?!\{\{secret:)\S+/gi, "$1 •••")
      .replace(/([?&](?:token|key|api[-_]?key|secret|password|access_token)=)(?!\{\{secret:)[^&\s]+/gi, "$1•••");
  }
  if (Array.isArray(value)) return value.map((v) => redactSpec(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactSpec(v, k)]));
  return value;
}

function inputSchemaOf(t: ResolvedTool): Record<string, unknown> {
  try { return t.inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }); }
  catch { return t.inputSchemaJson; }
}
function overrideView(o: ToolOverrideRow) {
  return { scope: o.scope, clientKey: o.client_key, enabled: o.enabled === null ? null : o.enabled === 1, promoted: o.promoted === null ? null : o.promoted === 1, title: o.title, description: o.description, updatedBy: o.updated_by, updatedAt: o.updated_at };
}

// ---------------------------------------------------------------------------------------------------------------------
// list_tools
// ---------------------------------------------------------------------------------------------------------------------
const listTools: BuiltinSpec = {
  name: "list_tools",
  title: "List tools",
  description: "List every tool this server knows — built-in and defined, listed and hidden, on and off — with the layer that decided each state, the promoted-slot budget and catalog_version. Hidden tools are still callable through call_tool. Filter with only: builtin | defined | visible | hidden | disabled.",
  inputSchema: listToolsInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  meta: { "anthropic/alwaysLoad": true },
  async handler(args, exec) {
    const { include_hidden, only } = args as z.infer<typeof listToolsInput>;
    const { catalog } = exec;
    const identity = catalog.identity.name;
    let rows = [...catalog.tools.values()].sort(byName);
    if (!include_hidden) rows = rows.filter(isVisible);
    if (only === "builtin") rows = rows.filter((t) => t.kind === "builtin");
    else if (only === "defined") rows = rows.filter((t) => t.kind !== "builtin");
    else if (only === "visible") rows = rows.filter(isVisible);
    else if (only === "hidden") rows = rows.filter((t) => t.state.enabled && !t.state.promoted);
    else if (only === "disabled") rows = rows.filter((t) => !t.state.enabled);
    const defined = [...catalog.tools.values()].filter((t) => t.kind !== "builtin").length;
    const lines = ["name · kind · title · enabled · promoted · visible · protected · decidedBy(enabled/promoted) · full-name length"];
    for (const t of rows) {
      lines.push(`${t.name} · ${t.kind} · ${t.state.title} · ${onoff(t.state.enabled)} · ${onoff(t.state.promoted)} · ${yn(isVisible(t))} · ${yn(t.protected)} · ${t.state.decidedBy.enabled}/${t.state.decidedBy.promoted} · ${claudeCodeName(identity, t.name).length}`);
    }
    if (rows.length === 0) lines.push("(no tools match)");
    lines.push("", `visible ${catalog.visible.length} · budget ${catalog.budget.usedDeploy}/${catalog.budget.limit} (+${catalog.budget.usedClient} client) · defined ${defined} · upstreams ${catalog.upstreams.length} · catalog_version ${catalog.catalogVersion} · identity ${identity}`);
    if (catalog.warnings.length) lines.push("", ...catalog.warnings.map((w) => `warning: ${w}`));
    return withRefreshHint(ok(lines.join("\n"), {
      tools: rows.map((t) => ({ name: t.name, kind: t.kind, title: t.state.title, enabled: t.state.enabled, promoted: t.state.promoted, visible: isVisible(t), protected: t.protected, decidedBy: t.state.decidedBy, origin: originOf(t) })),
      budget: catalog.budget, catalogVersion: catalog.catalogVersion, identity, warnings: catalog.warnings
    }));
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// describe_tool
// ---------------------------------------------------------------------------------------------------------------------
const describeTool: BuiltinSpec = {
  name: "describe_tool",
  title: "Describe tool",
  description: "Show one tool in full: title, description, JSON input schema, annotations, effective state per layer, override rows, the (secret-redacted) definition spec, the cached upstream entry or compose steps, and its Claude Code name mcp__<key>__<name> with its length.",
  inputSchema: describeToolInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  meta: { "anthropic/alwaysLoad": true },
  async handler(args, exec) {
    const { name } = args as z.infer<typeof describeToolInput>;
    const { catalog, scope } = exec;
    const t = catalog.tools.get(name);
    if (!t) return unknownTool(name, catalog);
    const cc = claudeCodeName(catalog.identity.name, name);
    const inputSchema = inputSchemaOf(t);
    let overrides: ReturnType<typeof overrideView>[] = [];
    if (!catalog.schemaMissing) {
      try { overrides = (await listOverridesFor(scope.env.DB, name, scope.principal.clientKey)).map(overrideView); }
      catch (e) { if (!isSchemaMissing(e)) throw e; }
    }
    const spec = t.def ? redactSpec(t.spec) : undefined;
    let upstreamTool: unknown;
    let steps: { id: string; tool: string; kind: string | null; enabled: boolean | null; promoted: boolean | null }[] | undefined;
    if (t.def && t.kind === "mcp" && t.spec && typeof t.spec === "object") {
      const s = t.spec as { upstream?: string; tool?: string };
      try {
        const up = s.upstream ? await getUpstreamFull(scope.env.DB, s.upstream) : null;
        const cache = up?.tool_cache ? (JSON.parse(up.tool_cache) as unknown) : null;
        const list = Array.isArray(cache) ? cache : cache && typeof cache === "object" && Array.isArray((cache as { tools?: unknown }).tools) ? (cache as { tools: unknown[] }).tools : [];
        upstreamTool = list.find((x) => x && typeof x === "object" && (x as { name?: string }).name === s.tool) ?? null;
      } catch (e) { if (!isSchemaMissing(e)) throw e; }
    }
    if (t.def && t.kind === "compose" && t.spec && typeof t.spec === "object") {
      const s = t.spec as { steps?: { id: string; tool: string }[] };
      steps = (s.steps ?? []).map((st) => {
        const target = catalog.tools.get(st.tool);
        return { id: st.id, tool: st.tool, kind: target?.kind ?? null, enabled: target?.state.enabled ?? null, promoted: target?.state.promoted ?? null };
      });
    }
    const lines = [
      `\`${name}\` — ${t.kind}${t.kind === "builtin" ? "" : " (defined)"} — ${t.state.title}`,
      t.state.description,
      "",
      `Claude Code name: ${cc} (${cc.length} chars)`,
      `State: ${onoff(t.state.enabled)} (decided by ${t.state.decidedBy.enabled} layer) · ${t.state.promoted ? "listed" : "hidden"} (decided by ${t.state.decidedBy.promoted} layer) · ${isVisible(t) ? "visible in tools/list" : "not in tools/list — call via call_tool"}${t.protected ? " · protected" : ""}${t.state.deployDisabled ? " · disabled by the deploy layer" : ""}`,
      `Annotations: readOnly ${yn(t.annotations.readOnlyHint)} · destructive ${yn(t.annotations.destructiveHint)} · idempotent ${yn(t.annotations.idempotentHint)} · openWorld ${yn(t.annotations.openWorldHint)}`,
      ...(t.meta ? [`_meta: ${JSON.stringify(t.meta)}`] : []),
      "",
      "Input schema:",
      JSON.stringify(inputSchema, null, 2),
      "",
      `Overrides: ${overrides.length ? overrides.map((o) => `${o.scope}${o.clientKey ? `(${o.clientKey})` : ""} ${JSON.stringify({ enabled: o.enabled, promoted: o.promoted, title: o.title, description: o.description })}`).join("; ") : "none"}`
    ];
    if (t.def) {
      lines.push("", `Spec (${t.kind}, secrets redacted):`, JSON.stringify(spec, null, 2));
      if (upstreamTool !== undefined) lines.push("", "Upstream tool (cached):", JSON.stringify(upstreamTool, null, 2));
      if (steps) lines.push("", "Steps:", ...steps.map((s) => `  ${s.id} → ${s.tool} (${s.kind ?? "missing"}${s.enabled === false ? ", disabled" : ""})`));
      lines.push("", `Defined by ${t.def.created_by} at ${t.def.created_at}; updated ${t.def.updated_at}; version ${t.def.version}.`);
    }
    return ok(lines.join("\n"), {
      name, kind: t.kind, origin: originOf(t), title: t.state.title, description: t.state.description, inputSchema, annotations: t.annotations,
      _meta: t.meta ?? null, protected: t.protected, state: { enabled: t.state.enabled, promoted: t.state.promoted, visible: isVisible(t), deployDisabled: t.state.deployDisabled }, decidedBy: t.state.decidedBy,
      overrides, spec: spec ?? null, upstreamTool: upstreamTool ?? null, steps: steps ?? null,
      createdBy: t.def?.created_by ?? null, createdAt: t.def?.created_at ?? null, updatedAt: t.def?.updated_at ?? null, version: t.def?.version ?? null,
      claudeCodeName: cc, claudeCodeNameLength: cc.length
    });
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// call_tool
// ---------------------------------------------------------------------------------------------------------------------
const callTool: BuiltinSpec = {
  name: "call_tool",
  title: "Call tool",
  description: "Run any enabled tool by name — including hidden (unpromoted) tools that are not in your tool list — and return its result verbatim. Refuses disabled and unknown tools. arguments must match the target's input schema (see describe_tool).",
  inputSchema: callToolInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  meta: { "anthropic/alwaysLoad": true },
  async handler(args, exec) {
    const { name, arguments: toolArgs } = args as z.infer<typeof callToolInput>;
    return invoke(exec.scope, exec.catalog, name, toolArgs, { depth: exec.depth + 1 });
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// toggle_tool
// ---------------------------------------------------------------------------------------------------------------------
const toggleTool: BuiltinSpec = {
  name: "toggle_tool",
  title: "Toggle tool",
  description: "Switch a tool on or off. Omit enabled to flip. scope 'deploy' (default) affects every connection; scope 'client' affects one client key (yours unless client is given) and can never re-enable a tool the deploy layer disabled. Protected tools cannot be toggled.",
  inputSchema: toggleToolInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, exec) => guarded(async () => {
    const { name, enabled, scope, client } = args as z.infer<typeof toggleToolInput>;
    if (exec.catalog.schemaMissing) return dbNotMigrated();
    const key = keyFor(exec, scope, client);
    const view = await viewFor(exec, scope, key);
    const t = view.tools.get(name);
    if (!t) return unknownTool(name, view);
    if (t.protected) return protectedTool(name);
    const next = enabled ?? !t.state.enabled;
    const db = exec.scope.env.DB;
    const actor = actorOf(exec);
    if (scope === "client" && next) await deleteOverride(db, "client", key, name, actor);      // a client cannot undo a deploy disable
    else await upsertOverride(db, scope, key, name, { enabled: next }, actor);
    notifyToolsChanged();
    const after = await reresolve(exec, scope === "client" ? key : exec.scope.principal.clientKey);
    const s = after.tools.get(name)?.state ?? t.state;
    const text = `\`${name}\` switched ${onoff(next)} at scope ${scope}${scope === "client" ? ` (client key ${key})` : ""}. ` +
      `Effective: ${onoff(s.enabled)} (decided by the ${s.decidedBy.enabled} layer)${s.deployDisabled && scope === "client" ? " — the deploy layer still has it off; toggle_tool {scope:\"deploy\", enabled:true} re-enables it" : ""}. ` +
      `${s.enabled ? (s.promoted ? "Listed in tools/list." : "Hidden; callable via call_tool.") : "Not registered until re-enabled."} catalog_version ${after.catalogVersion}.`;
    return withRefreshHint(ok(text, { name, scope, clientKey: key, enabled: s.enabled, promoted: s.promoted, visible: s.enabled && s.promoted, decidedBy: s.decidedBy, deployDisabled: s.deployDisabled, catalogVersion: after.catalogVersion }));
  })
};

// ---------------------------------------------------------------------------------------------------------------------
// promote_tool / demote_tool
// ---------------------------------------------------------------------------------------------------------------------
const promoteTool: BuiltinSpec = {
  name: "promote_tool",
  title: "Promote tool",
  description: "List a tool in tools/list so the model sees it. Defined tools start hidden; promoting one takes a slot of the promoted budget (default 12) at that scope ('deploy' = everyone, 'client' = one client key). Requires the tool to be enabled. Clients cache tool lists — refresh afterwards.",
  inputSchema: promoteToolInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, exec) => guarded(async () => {
    const { name, scope, client } = args as z.infer<typeof promoteToolInput>;
    if (exec.catalog.schemaMissing) return dbNotMigrated();
    const key = keyFor(exec, scope, client);
    const view = await viewFor(exec, scope, key);
    const t = view.tools.get(name);
    if (!t) return unknownTool(name, view);
    if (!t.state.enabled) return fail("tool_disabled", `'${name}' is switched off (${t.state.decidedBy.enabled} layer); enable it before promoting.`, t.state.deployDisabled ? "toggle_tool {name, enabled:true, scope:\"deploy\"} re-enables it." : "toggle_tool {name, enabled:true} re-enables it.");
    const limit = view.budget.limit;
    if (t.kind !== "builtin") {
      const alreadyAtScope = t.state.promoted && t.state.decidedBy.promoted === scope;
      const used = scope === "deploy" ? view.budget.usedDeploy : view.budget.usedClient;
      if (!alreadyAtScope && used >= limit) {
        const holders = promotedAt(view, scope);
        return fail("slot_budget_exceeded", `The ${scope} layer already lists ${used} of ${limit} defined tools: ${holders.join(", ") || "(none)"}.`,
          "demote_tool one of them (it stays callable via call_tool), or raise promoted_budget in settings.", { scope, used, limit, promoted: holders });
      }
    }
    await upsertOverride(exec.scope.env.DB, scope, key, name, { promoted: true }, actorOf(exec));
    notifyToolsChanged();
    const after = await reresolve(exec, scope === "client" ? key : exec.scope.principal.clientKey);
    const usedAfter = scope === "deploy" ? after.budget.usedDeploy : after.budget.usedClient;
    const cc = claudeCodeName(after.identity.name, name);
    const text = `Promoted \`${name}\` (visible ${usedAfter} of budget ${limit}) at scope ${scope}${scope === "client" ? ` for client key ${key}` : ""}. Claude Code shows it as ${cc}.`;
    return withRefreshHint(ok(text, { name, scope, clientKey: key, visible: true, budget: after.budget, claudeCodeName: cc, catalogVersion: after.catalogVersion }));
  })
};

const demoteTool: BuiltinSpec = {
  name: "demote_tool",
  title: "Demote tool",
  description: "Hide a tool from tools/list without disabling it — it stays callable through call_tool. Works on built-ins too (except protected ones). Frees a promoted slot for defined tools. scope 'deploy' hides it for everyone, 'client' for one client key.",
  inputSchema: demoteToolInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, exec) => guarded(async () => {
    const { name, scope, client } = args as z.infer<typeof demoteToolInput>;
    if (exec.catalog.schemaMissing) return dbNotMigrated();
    const key = keyFor(exec, scope, client);
    const view = await viewFor(exec, scope, key);
    const t = view.tools.get(name);
    if (!t) return unknownTool(name, view);
    if (t.protected) return protectedTool(name);
    await upsertOverride(exec.scope.env.DB, scope, key, name, { promoted: false }, actorOf(exec));
    notifyToolsChanged();
    const after = await reresolve(exec, scope === "client" ? key : exec.scope.principal.clientKey);
    const text = `Demoted \`${name}\` at scope ${scope}${scope === "client" ? ` for client key ${key}` : ""}: hidden from tools/list, still callable via call_tool {name:"${name}"}. catalog_version ${after.catalogVersion}.`;
    return withRefreshHint(ok(text, { name, scope, clientKey: key, visible: false, budget: after.budget, catalogVersion: after.catalogVersion }));
  })
};

// ---------------------------------------------------------------------------------------------------------------------
// remove_tool
// ---------------------------------------------------------------------------------------------------------------------
const removeTool: BuiltinSpec = {
  name: "remove_tool",
  title: "Remove tool",
  description: "Permanently delete a defined tool (template, http, mcp or compose) together with every override that names it. Built-ins cannot be removed — use toggle_tool or demote_tool. Requires confirm:true.",
  inputSchema: removeToolInput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  meta: { "anthropic/requiresUserInteraction": true },
  handler: (args, exec) => guarded(async () => {
    const { name } = args as z.infer<typeof removeToolInput>;
    if (exec.catalog.schemaMissing) return dbNotMigrated();
    const t = exec.catalog.tools.get(name);
    if (!t) return unknownTool(name, exec.catalog);
    if (t.kind === "builtin") return fail("not_a_definition", `'${name}' is a built-in tool and cannot be removed.`, "toggle_tool {name, enabled:false} switches it off; demote_tool hides it.");
    await deleteDef(exec.scope.env.DB, name, actorOf(exec));
    notifyToolsChanged();
    const after = await reresolve(exec);
    return withRefreshHint(ok(`Removed \`${name}\` (${t.kind}) and its overrides. catalog_version ${after.catalogVersion}.`, { name, kind: t.kind, removed: true, catalogVersion: after.catalogVersion }));
  })
};

// ---------------------------------------------------------------------------------------------------------------------
// override_tool
// ---------------------------------------------------------------------------------------------------------------------
const overrideTool: BuiltinSpec = {
  name: "override_tool",
  title: "Override tool text",
  description: "Set a deploy-wide title and/or description override for any tool — for example rewrite a built-in's description for your team. The override wins over the code or definition text for every connection. reset:true clears it.",
  inputSchema: overrideToolInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, exec) => guarded(async () => {
    const { name, title, description, reset } = args as z.infer<typeof overrideToolInput>;
    if (exec.catalog.schemaMissing) return dbNotMigrated();
    const t = exec.catalog.tools.get(name);
    if (!t) return unknownTool(name, exec.catalog);
    if (!reset && title === undefined && description === undefined) return fail("invalid_arguments", "Nothing to change.", "Pass title and/or description, or reset:true.");
    const patch = reset ? { title: null, description: null } : { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}) };
    await upsertOverride(exec.scope.env.DB, "deploy", "", name, patch, actorOf(exec));
    notifyToolsChanged();
    const after = await reresolve(exec);
    const s = after.tools.get(name)?.state ?? t.state;
    const text = reset
      ? `Cleared the deploy override of \`${name}\`; it shows as "${s.title}" again. catalog_version ${after.catalogVersion}.`
      : `\`${name}\` now shows as "${s.title}"${description !== undefined ? " with the new description" : ""} for every connection. catalog_version ${after.catalogVersion}.`;
    return withRefreshHint(ok(text, { name, title: s.title, description: s.description, reset, catalogVersion: after.catalogVersion }));
  })
};

export const metaTools: BuiltinSpec[] = [listTools, describeTool, callTool, toggleTool, promoteTool, demoteTool, removeTool, overrideTool];
