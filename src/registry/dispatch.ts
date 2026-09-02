// src/registry/dispatch.ts [B] — the single dispatch path (§12.5). Every tool call — direct tools/call, call_tool,
// compose steps — goes through invoke(): guards (unknown, self-call, disabled, depth, hop, schema) → validate → run.
// Tools never throw: any exception becomes fail("internal").
import type { CallToolResult } from "@modelcontextprotocol/server";
import { fail } from "../mcp/result";
import { KINDS } from "./kinds/index";
import type { ExecContext, RequestScope, ResolvedCatalog } from "../types";

export const MAX_DEPTH = 3;
export const MAX_HOP = 3;

export interface InvokeOptions { depth: number }

export async function invoke(scope: RequestScope, catalog: ResolvedCatalog, name: string, rawArgs: Record<string, unknown> | undefined, opts: InvokeOptions): Promise<CallToolResult> {
  const t = catalog.tools.get(name);
  if (!t) return fail("unknown_tool", `No tool named '${name}'.`, `Nearest: ${nearest(name, catalog)}. Call list_tools to see every tool, including hidden ones.`);
  if (name === "call_tool" && opts.depth > 0) return fail("depth_exceeded", "call_tool cannot call itself.");
  if (!t.state.enabled) return fail("tool_disabled", `'${name}' is switched off (${t.state.decidedBy.enabled} layer).`, t.state.deployDisabled ? "The deploy layer disabled it; only toggle_tool at scope 'deploy' (or the owner console) can re-enable it." : "toggle_tool {name, enabled:true} re-enables it.");
  if (opts.depth > MAX_DEPTH) return fail("depth_exceeded", `Nesting deeper than ${MAX_DEPTH}.`);
  if (scope.hop >= MAX_HOP) return fail("hop_limit", `This call already crossed ${MAX_HOP} homcp deployments.`, "A definition is probably proxying itself through an upstream; check list_upstreams.");
  if (catalog.schemaMissing && t.kind !== "builtin") return fail("db_not_migrated", "The registry database is not migrated.", "Run `npm run db:migrate:remote`.");
  const parsed = await t.inputSchema["~standard"].validate(rawArgs ?? {});
  if (parsed.issues) return fail("invalid_arguments", formatIssues(parsed.issues), "describe_tool shows the schema.");
  const exec: ExecContext = { scope, catalog, depth: opts.depth };
  try {
    if (t.kind === "builtin") return await t.builtin!.handler(parsed.value as Record<string, unknown>, exec);
    return await KINDS[t.kind].run(t, parsed.value as Record<string, unknown>, exec);
  } catch (e) { console.error("tool_failed", name, t.kind, String(e)); return fail("internal", "The tool failed unexpectedly.", undefined, { kind: t.kind }); }
}

// ---------------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------------
export interface IssueLike { readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined }

/** "path: message; path: message" — StandardSchema issues (zod and fromJsonSchema alike). */
export function formatIssues(issues: ReadonlyArray<IssueLike>): string {
  const lines = issues.slice(0, 12).map((i) => {
    const path = (i.path ?? []).map((p) => String(typeof p === "object" && p !== null && "key" in p ? p.key : p)).join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
  if (issues.length > 12) lines.push(`… ${issues.length - 12} more`);
  return lines.join("; ") || "invalid arguments";
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** The n closest tool names (substring hits first, then edit distance), comma-separated — for unknown_tool hints. */
export function nearest(name: string, catalog: ResolvedCatalog, n = 3): string {
  const q = name.toLowerCase();
  const scored = [...catalog.tools.keys()].map((k) => {
    const lk = k.toLowerCase();
    const d = q && (lk.includes(q) || q.includes(lk)) ? 0 : distance(q, lk);
    return { k, d };
  });
  scored.sort((x, y) => x.d - y.d || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
  return scored.slice(0, n).map((x) => x.k).join(", ") || "(no tools)";
}
