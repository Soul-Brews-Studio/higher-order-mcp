// src/registry/kinds/compose.ts [C] — kind "compose": sequential steps with arg mapping (§12.3).
// Define-time: unique ids; each step.tool exists (hidden ok, disabled → tool_disabled); no self-reference; compose→compose
// allowed (depth guard at runtime). Runtime: sequential invoke(step.tool, renderValue(step.args, {input, steps}), depth+1);
// steps[id] = {text, structured, isError}; on_error:"stop" → compose_step_failed {step} with partial steps in details;
// "continue" proceeds. Output `last` or `all`. Wall budget ≤ 45 s.
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { specCompose } from "../../mcp/schemas";
import { ok, fail } from "../../mcp/result";
import { invoke } from "../dispatch";
import { contextFor, renderValue, secretRefs, stepRefs, TemplateError, type StepResult } from "../../util/template";
import { undeclaredInputWarnings, withHomcpMeta } from "./template";
import type { ExecContext, KindModule, KindValidateContext, KindValidation, ResolvedTool, ToolAnnotations } from "../../types";

export type SpecCompose = z.infer<typeof specCompose>;

function textOf(r: CallToolResult): string {
  return (r.content ?? []).filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
}

export const composeKind: KindModule<SpecCompose> = {
  kind: "compose",
  specSchema: specCompose,
  async validate(spec: SpecCompose, ctx: KindValidateContext): Promise<KindValidation> {
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const step of spec.steps) {
      if (seen.has(step.id)) return { ok: false, code: "spec_invalid", message: `Step id '${step.id}' is used twice.` };
      if (step.tool === ctx.name) return { ok: false, code: "spec_invalid", message: `Step '${step.id}' calls '${ctx.name}' — a compose tool cannot call itself.` };
      if (step.tool === "call_tool") return { ok: false, code: "spec_invalid", message: `Step '${step.id}': name the target tool directly instead of call_tool.` };
      const t = ctx.catalog.tools.get(step.tool);
      if (!t) return { ok: false, code: "spec_invalid", message: `Step '${step.id}': no tool named '${step.tool}'.`, hint: "list_tools shows every tool, including hidden ones." };
      if (!t.state.enabled) return { ok: false, code: "tool_disabled", message: `Step '${step.id}': '${step.tool}' is switched off (${t.state.decidedBy.enabled} layer).`, hint: "toggle_tool {name, enabled:true} re-enables it." };
      if (secretRefs(step.args).length) return { ok: false, code: "spec_invalid", message: `Step '${step.id}': {{secret:NAME}} is not allowed in compose args.` };
      for (const ref of stepRefs(step.args)) {
        if (!seen.has(ref)) return { ok: false, code: "spec_invalid", message: `Step '${step.id}' references steps.${ref}, which ${ref === step.id ? "is itself" : "is not an earlier step"}.` };
      }
      try { renderValue(step.args, contextFor(ctx.scope, ctx.catalog), { warnings, dry: true }); }
      catch (e) {
        if (e instanceof TemplateError) return { ok: false, code: "spec_invalid", message: `Step '${step.id}': ${e.message}`, hint: e.hint };
        return { ok: false, code: "spec_invalid", message: `Step '${step.id}': ${String(e)}` };
      }
      if (t.kind === "compose") warnings.push(`step ${step.id} nests compose tool ${step.tool}; nesting deeper than 3 fails with depth_exceeded`);
      seen.add(step.id);
    }
    warnings.push(...undeclaredInputWarnings(spec.steps.map((s) => s.args), ctx.inputSchema));
    return { ok: true, warnings };
  },
  defaultAnnotations(spec: SpecCompose, ctx: KindValidateContext): ToolAnnotations {
    const hints = spec.steps.map((s) => ctx.catalog.tools.get(s.tool)?.annotations).filter((a): a is ToolAnnotations => !!a);
    if (!hints.length) return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    return {
      readOnlyHint: hints.every((h) => h.readOnlyHint),
      destructiveHint: hints.some((h) => h.destructiveHint),
      idempotentHint: hints.every((h) => h.idempotentHint),
      openWorldHint: hints.some((h) => h.openWorldHint)
    };
  },
  async run(tool: ResolvedTool, input: Record<string, unknown>, exec: ExecContext): Promise<CallToolResult> {
    const parsed = specCompose.safeParse(tool.spec);
    if (!parsed.success) return fail("spec_invalid", `Definition '${tool.name}' has an invalid compose spec.`, "describe_tool shows the stored spec; define_tool {replace:true} fixes it.");
    const spec = parsed.data;
    const warnings: string[] = [];
    const steps: Record<string, StepResult> = {};
    const order: string[] = [];
    const deadline = Date.now() + spec.timeout_ms;
    let last: CallToolResult | undefined;
    const stepDetails = () => ({ steps: Object.fromEntries(order.map((id) => [id, steps[id]])) });

    for (const step of spec.steps) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return fail("compose_step_failed", `Wall budget of ${spec.timeout_ms} ms ran out before step '${step.id}'.`, "Raise timeout_ms (max 45000) or split the tool.", { step: step.id, tool: step.tool, ...stepDetails() });
      let args: Record<string, unknown>;
      try { args = renderValue(step.args, contextFor(exec.scope, exec.catalog, input, steps), { warnings }) as Record<string, unknown>; }
      catch (e) {
        if (e instanceof TemplateError) return fail("spec_invalid", `Step '${step.id}': ${e.message}`, e.hint, { step: step.id, ...stepDetails() });
        throw e;
      }
      let r: CallToolResult;
      try {
        r = await Promise.race([
          invoke(exec.scope, exec.catalog, step.tool, args, { depth: exec.depth + 1 }),
          new Promise<CallToolResult>((resolve) => setTimeout(() => resolve(fail("compose_step_failed", `Step '${step.id}' (${step.tool}) exceeded the remaining wall budget (${remaining} ms).`)), remaining))
        ]);
      } catch (e) {
        r = fail("internal", `Step '${step.id}' (${step.tool}) threw: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
      }
      const record: StepResult = { text: textOf(r), structured: r.structuredContent, isError: r.isError === true };
      steps[step.id] = record; order.push(step.id); last = r;
      if (record.isError && spec.on_error === "stop") {
        const err = (r.structuredContent as { error?: unknown } | undefined)?.error;
        return fail("compose_step_failed", `Step '${step.id}' (${step.tool}) failed: ${record.text.split("\n")[0] ?? ""}`, "on_error:\"continue\" runs the remaining steps anyway.", { step: step.id, tool: step.tool, error: err ?? null, ...stepDetails() });
      }
    }

    const lastId = order[order.length - 1]!;
    let result: CallToolResult;
    if (spec.output === "all") {
      const text = order.map((id) => `## ${id} (${spec.steps.find((s) => s.id === id)!.tool})${steps[id]!.isError ? " — error" : ""}\n${steps[id]!.text}`).join("\n\n");
      result = ok(text, { steps: stepDetails().steps, last: steps[lastId]!.structured ?? null });
    } else {
      const content = last?.content?.length ? last.content : [{ type: "text" as const, text: steps[lastId]!.text }];
      result = { content, structuredContent: { steps: stepDetails().steps, last: steps[lastId]!.structured ?? null } };
    }
    const failed = order.filter((id) => steps[id]!.isError);
    if (failed.length) result = { ...result, isError: spec.output === "last" && last?.isError === true ? true : result.isError };
    return withHomcpMeta(result, { steps: order, ...(failed.length ? { failedSteps: failed } : {}), ...(warnings.length ? { warnings } : {}) });
  }
};
