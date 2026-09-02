// src/registry/kinds/template.ts [C] — kind "template": renders spec.text; format:"json" also parses into structuredContent.
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { specTemplate } from "../../mcp/schemas";
import { ok, fail } from "../../mcp/result";
import { contextFor, inputRefs, render, TemplateError } from "../../util/template";
import type { ExecContext, KindModule, KindValidateContext, KindValidation, ResolvedTool, ToolAnnotations } from "../../types";

export type SpecTemplate = z.infer<typeof specTemplate>;

/** Adds `_meta.homcp` (warnings and friends) to a result without disturbing existing metadata. */
export function withHomcpMeta(r: CallToolResult, meta: Record<string, unknown>): CallToolResult {
  const prev = (r._meta ?? {}) as Record<string, unknown>;
  const prevHomcp = (prev.homcp && typeof prev.homcp === "object" ? prev.homcp : {}) as Record<string, unknown>;
  return { ...r, _meta: { ...prev, homcp: { ...prevHomcp, ...meta } } };
}

/** Warns about `input.<key>` references that the declared input_schema does not list. */
export function undeclaredInputWarnings(value: unknown, inputSchema: Record<string, unknown> | undefined): string[] {
  if (!inputSchema) return [];
  const props = inputSchema.properties;
  if (!props || typeof props !== "object") return [];
  const declared = new Set(Object.keys(props as Record<string, unknown>));
  return inputRefs(value).filter((k) => !declared.has(k)).map((k) => `{{input.${k}}} is not declared in input_schema`);
}

export const templateKind: KindModule<SpecTemplate> = {
  kind: "template",
  specSchema: specTemplate,
  async validate(spec: SpecTemplate, ctx: KindValidateContext): Promise<KindValidation> {
    const warnings: string[] = [];
    try { render(spec.text, contextFor(ctx.scope, ctx.catalog), { warnings, dry: true }); }
    catch (e) {
      if (e instanceof TemplateError) return { ok: false, code: "spec_invalid", message: e.message, hint: e.hint };
      return { ok: false, code: "spec_invalid", message: String(e) };
    }
    warnings.push(...undeclaredInputWarnings(spec.text, ctx.inputSchema));
    return { ok: true, warnings };
  },
  defaultAnnotations(): ToolAnnotations {
    return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  },
  async run(tool: ResolvedTool, input: Record<string, unknown>, exec: ExecContext): Promise<CallToolResult> {
    const parsed = specTemplate.safeParse(tool.spec);
    if (!parsed.success) return fail("spec_invalid", `Definition '${tool.name}' has an invalid template spec.`, "describe_tool shows the stored spec; define_tool {replace:true} fixes it.");
    const spec = parsed.data;
    const warnings: string[] = [];
    let text: string;
    try { text = render(spec.text, contextFor(exec.scope, exec.catalog, input), { warnings }); }
    catch (e) {
      if (e instanceof TemplateError) return fail("spec_invalid", e.message, e.hint);
      throw e;
    }
    let result: CallToolResult;
    if (spec.format === "json") {
      let value: unknown;
      try { value = JSON.parse(text); }
      catch (e) { return fail("spec_invalid", `Rendered text is not valid JSON: ${String(e).slice(0, 200)}`, "format:\"json\" requires spec.text to render to a JSON document; use {{json input.x}} for values.", { text: text.slice(0, 2000) }); }
      const structured = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
      result = ok(text, structured);
    } else {
      result = ok(text);
    }
    return warnings.length ? withHomcpMeta(result, { warnings }) : result;
  }
};
