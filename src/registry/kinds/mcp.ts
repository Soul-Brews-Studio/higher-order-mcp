// src/registry/kinds/mcp.ts [C] — kind "mcp": per-request Client call of one upstream tool (§12.3).
// Define-time: upstream exists (unknown_upstream); withUpstream(listTools) succeeds (upstream_unreachable) and contains
// `tool` (upstream_tool_missing); schema:"snapshot" → upstream inputSchema minus bound keys becomes input_schema unless
// supplied; upstream title/description/annotations default; refreshes tool_cache.
// Runtime: args = {...input, ...renderValue(bind)} → callTool → passthrough content/structuredContent/isError (text prefixed
// `upstream <name>: ` on errors), `_meta.homcp.upstream`.
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { specMcp } from "../../mcp/schemas";
import { fail } from "../../mcp/result";
import { getUpstreamFull, updateUpstreamCache } from "../db";
import { describeUpstreamError, UpstreamCallError, withUpstream, type CachedTool } from "../upstream";
import { contextFor, renderValue, secretRefs, TemplateError } from "../../util/template";
import { withHomcpMeta } from "./template";
import type { ExecContext, KindModule, KindValidateContext, KindValidation, ResolvedTool, ToolAnnotations, UpstreamRow } from "../../types";

export type SpecMcp = z.infer<typeof specMcp>;

/** Trims an upstream tools/list entry to what the cache keeps (schemas, hints, copy — never server-side extras). */
export function toCachedTool(t: { name: string; title?: string; description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown }): CachedTool {
  return {
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    ...(t.description ? { description: t.description } : {}),
    ...(t.inputSchema && typeof t.inputSchema === "object" ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
    ...(t.outputSchema && typeof t.outputSchema === "object" ? { outputSchema: t.outputSchema as Record<string, unknown> } : {}),
    ...(t.annotations && typeof t.annotations === "object" ? { annotations: t.annotations as Record<string, unknown> } : {})
  };
}

/** Lists upstream tools live and refreshes the row's cache (best effort). */
export async function refreshUpstreamTools(scope: ExecContext["scope"], up: UpstreamRow, timeoutMs = 20_000): Promise<{ tools: CachedTool[]; serverInfo: unknown }> {
  const { tools, serverInfo } = await withUpstream(scope, up, async (c) => {
    const r = await c.listTools();
    return { tools: r.tools.map(toCachedTool), serverInfo: c.getServerVersion() ?? null };
  }, timeoutMs);
  try { await updateUpstreamCache(scope.env.DB, up.name, JSON.stringify(serverInfo), JSON.stringify(tools)); }
  catch (e) { console.warn("upstream cache update failed", up.name, String(e)); }
  return { tools, serverInfo };
}

/** The upstream input schema minus the keys the definition binds. */
export function snapshotSchema(schema: Record<string, unknown> | undefined, bound: string[]): Record<string, unknown> {
  const base = schema && typeof schema === "object" ? { ...schema } : {};
  const props = { ...((base.properties as Record<string, unknown> | undefined) ?? {}) };
  for (const k of bound) delete props[k];
  const required = Array.isArray(base.required) ? (base.required as unknown[]).filter((r) => typeof r === "string" && !bound.includes(r)) : undefined;
  const out: Record<string, unknown> = { ...base, type: "object", properties: props };
  if (required && required.length) out.required = required; else delete out.required;
  delete out.$schema;
  return out;
}

function hintsFrom(annotations: Record<string, unknown> | undefined): Partial<ToolAnnotations> | undefined {
  if (!annotations) return undefined;
  const pick = (k: keyof ToolAnnotations) => (typeof annotations[k] === "boolean" ? { [k]: annotations[k] as boolean } : {});
  const out = { ...pick("readOnlyHint"), ...pick("destructiveHint"), ...pick("idempotentHint"), ...pick("openWorldHint") };
  return Object.keys(out).length ? out : undefined;
}

export const mcpKind: KindModule<SpecMcp> = {
  kind: "mcp",
  specSchema: specMcp,
  async validate(spec: SpecMcp, ctx: KindValidateContext): Promise<KindValidation> {
    const warnings: string[] = [];
    if (!ctx.catalog.upstreams.some((u) => u.name === spec.upstream)) return { ok: false, code: "unknown_upstream", message: `No upstream named '${spec.upstream}'.`, hint: "add_upstream registers one; list_upstreams shows them." };
    const up = await getUpstreamFull(ctx.scope.env.DB, spec.upstream);
    if (!up) return { ok: false, code: "unknown_upstream", message: `No upstream named '${spec.upstream}'.` };
    if (secretRefs(spec.bind).length) return { ok: false, code: "spec_invalid", message: "{{secret:NAME}} is not allowed in bind; use the upstream's auth instead." };
    try { renderValue(spec.bind, contextFor(ctx.scope, ctx.catalog), { warnings, dry: true }); }
    catch (e) {
      if (e instanceof TemplateError) return { ok: false, code: "spec_invalid", message: e.message, hint: e.hint };
      return { ok: false, code: "spec_invalid", message: String(e) };
    }
    let tools: CachedTool[];
    try { tools = (await refreshUpstreamTools(ctx.scope, up, spec.timeout_ms)).tools; }
    catch (e) { return { ok: false, code: "upstream_unreachable", message: `Upstream '${spec.upstream}' could not be reached: ${describeUpstreamError(e)}`, hint: "Check the URL and auth with upstream_tools {upstream, refresh:true}." }; }
    const t = tools.find((x) => x.name === spec.tool);
    if (!t) {
      const names = tools.map((x) => x.name);
      const near = names.filter((n) => n.includes(spec.tool) || spec.tool.includes(n)).slice(0, 5);
      return { ok: false, code: "upstream_tool_missing", message: `Upstream '${spec.upstream}' has no tool named '${spec.tool}'.`, hint: `${near.length ? `Nearest: ${near.join(", ")}. ` : ""}upstream_tools {upstream:"${spec.upstream}"} lists ${names.length} tools.` };
    }
    const bound = Object.keys(spec.bind);
    const declared = new Set(Object.keys((t.inputSchema?.properties as Record<string, unknown> | undefined) ?? {}));
    for (const k of bound) if (declared.size && !declared.has(k)) warnings.push(`bind.${k} is not a parameter of upstream tool ${spec.tool}`);
    const out: KindValidation = { ok: true, warnings };
    if (spec.schema === "snapshot" && !ctx.inputSchema) out.inputSchema = snapshotSchema(t.inputSchema, bound);
    if (t.title) out.title = t.title.slice(0, 80);
    if (t.description) out.description = t.description.slice(0, 1500);
    const hints = hintsFrom(t.annotations);
    if (hints) out.annotations = hints;
    return out;
  },
  defaultAnnotations(): ToolAnnotations {
    return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  },
  async run(tool: ResolvedTool, input: Record<string, unknown>, exec: ExecContext): Promise<CallToolResult> {
    const parsed = specMcp.safeParse(tool.spec);
    if (!parsed.success) return fail("spec_invalid", `Definition '${tool.name}' has an invalid mcp spec.`, "describe_tool shows the stored spec; define_tool {replace:true} fixes it.");
    const spec = parsed.data;
    const up = await getUpstreamFull(exec.scope.env.DB, spec.upstream);
    if (!up) return fail("unknown_upstream", `Upstream '${spec.upstream}' no longer exists.`, `remove_tool {name:"${tool.name}", confirm:true} or add_upstream {name:"${spec.upstream}"} again.`);
    const warnings: string[] = [];
    let args: Record<string, unknown>;
    try { args = { ...input, ...(renderValue(spec.bind, contextFor(exec.scope, exec.catalog, input), { warnings }) as Record<string, unknown>) }; }
    catch (e) {
      if (e instanceof TemplateError) return fail("spec_invalid", e.message, e.hint);
      throw e;
    }
    let result: CallToolResult;
    try {
      result = await withUpstream(exec.scope, up, async (c) => {
        try { return (await c.callTool({ name: spec.tool, arguments: args }, { timeout: spec.timeout_ms })) as CallToolResult; }
        catch (e) { throw new UpstreamCallError(e); }
      }, spec.timeout_ms);
    } catch (e) {
      const message = describeUpstreamError(e);
      if (e instanceof UpstreamCallError) return fail("upstream_error", `upstream ${spec.upstream}: ${spec.tool} failed: ${message}`, "The upstream rejected the call; upstream_tools {refresh:true} shows its current schema.", { upstream: spec.upstream, tool: spec.tool });
      return fail("upstream_unreachable", `upstream ${spec.upstream}: could not be reached: ${message}`, "Check list_upstreams and the upstream's auth.", { upstream: spec.upstream, tool: spec.tool });
    }
    const isError = result.isError === true;
    const content = (result.content ?? []).map((c) => (isError && c.type === "text" ? { ...c, text: `upstream ${spec.upstream}: ${(c as { text: string }).text}` } : c));
    const passthrough: CallToolResult = {
      content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(isError ? { isError: true } : {}),
      ...(result._meta ? { _meta: result._meta } : {})
    };
    return withHomcpMeta(passthrough, { upstream: spec.upstream, tool: spec.tool, ...(warnings.length ? { warnings } : {}) });
  }
};
