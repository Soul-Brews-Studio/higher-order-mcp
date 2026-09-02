// src/registry/resolve.ts [B] — pure resolver (§10.2 verbatim). BUILTIN → DEPLOY → CLIENT; no I/O.
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BuiltinSpec, Identity, Layer, Principal, ResolvedCatalog, ResolvedTool, Snapshot, ToolAnnotations } from "../types";
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
function fromBuiltin(b: BuiltinSpec): ResolvedTool {
  return { name: b.name, kind: "builtin", protected: !!b.protected, annotations: b.annotations, meta: b.meta,
    inputSchema: b.inputSchema, inputSchemaJson: z.toJSONSchema(b.inputSchema) as Record<string, unknown>, builtin: b,
    state: { enabled: true, promoted: !b.hiddenByDefault, title: b.title, description: b.description, decidedBy: { enabled: "builtin", promoted: "builtin" }, deployDisabled: false } };
}
function fromDef(d: Snapshot["defs"][number], warnings: string[]): ResolvedTool | null {
  try {
    const json = JSON.parse(d.input_schema) as Record<string, unknown>;
    const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...(JSON.parse(d.annotations) as Partial<ToolAnnotations>) };
    return { name: d.name, kind: d.kind, protected: false, annotations, inputSchema: fromJsonSchema(json), inputSchemaJson: json, def: d, spec: JSON.parse(d.spec),
      state: { enabled: true, promoted: false, title: d.title, description: d.description, decidedBy: { enabled: "builtin", promoted: "builtin" }, deployDisabled: false } };
  } catch (e) { warnings.push(`definition ${d.name} is unreadable and was skipped: ${String(e)}`); return null; }
}
export function resolveCatalog(builtins: BuiltinSpec[], snap: Snapshot, principal: Principal, identity: Identity): ResolvedCatalog {
  const warnings: string[] = [];
  const tools = new Map<string, ResolvedTool>();
  for (const b of builtins) tools.set(b.name, fromBuiltin(b));                                   // 1. GLOBAL
  for (const d of snap.defs) {                                                                    // 2. DEPLOY definitions (enabled, hidden)
    if (tools.has(d.name)) { warnings.push(`definition ${d.name} shadows a built-in and was ignored`); continue; }
    const t = fromDef(d, warnings); if (t) tools.set(d.name, t);
  }
  for (const scope of ["deploy", "client"] as const) {                                            // 3. overrides, deploy then client
    for (const o of snap.overrides) {
      if (o.scope !== scope) continue;
      const t = tools.get(o.tool_name); if (!t) continue;                                          // stale row ignored
      const layer: Layer = scope;
      if (o.enabled !== null && !t.protected) {
        if (scope === "deploy") { t.state.enabled = o.enabled === 1; t.state.deployDisabled = o.enabled === 0; t.state.decidedBy.enabled = layer; }
        else if (!t.state.deployDisabled) { t.state.enabled = o.enabled === 1; t.state.decidedBy.enabled = layer; }
      }
      if (o.promoted !== null && !t.protected) { t.state.promoted = o.promoted === 1; t.state.decidedBy.promoted = layer; }
      if (scope === "deploy") { if (o.title) t.state.title = o.title; if (o.description) t.state.description = o.description; }
    }
  }
  for (const t of tools.values()) if (t.protected) { t.state.enabled = true; t.state.promoted = true; t.state.deployDisabled = false; }   // 4. protected invariant
  const visible = [...tools.values()].filter((t) => t.state.enabled && t.state.promoted).sort(byName);                                // 5. deterministic
  const usedDeploy = [...tools.values()].filter((t) => t.kind !== "builtin" && t.state.promoted && t.state.decidedBy.promoted === "deploy").length;
  const usedClient = [...tools.values()].filter((t) => t.kind !== "builtin" && t.state.promoted && t.state.decidedBy.promoted === "client").length;
  if (usedDeploy > snap.promotedBudget) warnings.push(`deploy layer has ${usedDeploy} promoted definitions, budget is ${snap.promotedBudget}`);
  if (snap.schemaMissing) warnings.push("database not migrated: run `npm run db:migrate:remote`; only built-in tools are available and registry/memory tools will fail");
  return { tools, visible, budget: { limit: snap.promotedBudget, usedDeploy, usedClient }, identity, principal, catalogVersion: snap.catalogVersion, upstreams: snap.upstreams, schemaMissing: snap.schemaMissing, warnings };
}
