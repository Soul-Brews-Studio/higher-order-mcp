// src/tools/builtin/forge.ts [B] — define_tool (§12.1 algorithm). Kind execution lives in src/registry/kinds/* [C];
// this file only orchestrates: name → schema → spec parse → kind.validate → annotations → budget → one batch → notify.
import type { z } from "zod";
import { notifyToolsChanged } from "../../mcp/handler";
import { fail, ok, withRefreshHint } from "../../mcp/result";
import { defineToolInput } from "../../mcp/schemas";
import { MAX_DEFINITIONS, countDefs, insertDef, replaceDef, type ToolDefInput } from "../../registry/db";
import { formatIssues } from "../../registry/dispatch";
import { KINDS } from "../../registry/kinds/index";
import { validateInputSchema, validateToolName } from "../../registry/names";
import type { BuiltinSpec, DefinedKind, KindModule, KindValidateContext, ToolAnnotations } from "../../types";
import { actorOf, claudeCodeName, dbNotMigrated, guarded, reresolve } from "./meta";

/** Used when neither the caller nor the kind supplies an input_schema. */
export const DEFAULT_INPUT_SCHEMA: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: false };

const SPEC_HINTS: Record<DefinedKind, string> = {
  template: 'spec: { text: "Standup for {{input.project}} on {{now.date}}", format?: "text" | "json" }',
  http: 'spec: { method?: "GET", url: "https://api.example.com/items?q={{input.q}}", headers?: { authorization: "Bearer {{secret:API}}" }, body?, response?: "auto" | "json" | "text", json_path?, timeout_ms?, max_bytes?, allowed_hosts? }',
  mcp: 'spec: { upstream: "<name from add_upstream>", tool: "<upstream tool name>", bind?: { fixed_arg: "value" }, schema?: "snapshot" | "none", timeout_ms? }',
  compose: 'spec: { steps: [{ id: "s1", tool: "remember", args: { content: "{{input.note}}" } }, { id: "s2", tool: "recall", args: { query: "{{steps.s1.structured.title}}" } }], on_error?: "stop" | "continue", output?: "last" | "all" }'
};

const defineTool: BuiltinSpec = {
  name: "define_tool",
  title: "Define tool",
  description: "Create a tool at runtime. kind: template (render text/JSON from arguments), http (one https request to an allow-listed host), mcp (proxy one tool of an add_upstream server), compose (run other tools in sequence). New tools are callable at once via call_tool and hidden until promote_tool (or promote:true). replace:true updates an existing definition in place.",
  inputSchema: defineToolInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: (args, exec) => guarded(async () => {
    const input = args as z.infer<typeof defineToolInput>;
    const { catalog, scope } = exec;
    if (catalog.schemaMissing) return dbNotMigrated();

    const nameErr = validateToolName(input.name, catalog, { replace: input.replace });
    if (nameErr) return fail(nameErr.code, nameErr.message, nameErr.hint);
    const existing = catalog.tools.get(input.name);
    const replacing = !!existing && existing.kind !== "builtin" && input.replace;

    if (!replacing) {
      const n = await countDefs(scope.env.DB);
      if (n >= MAX_DEFINITIONS) return fail("slot_budget_exceeded", `This deployment already has ${n} defined tools; the maximum is ${MAX_DEFINITIONS}.`, "remove_tool frees a slot.", { definitions: n, max: MAX_DEFINITIONS });
    }

    const callerSchema = input.input_schema;
    if (callerSchema !== undefined) {
      const err = validateInputSchema(callerSchema);
      if (err) return fail(err.code, err.message, err.hint);
    }

    const kind = KINDS[input.kind] as KindModule<unknown> | undefined;
    if (!kind) return fail("spec_invalid", `Unknown kind '${input.kind}'.`, "kind must be template, http, mcp or compose.");
    const specParsed = kind.specSchema.safeParse(input.spec);
    if (!specParsed.success) return fail("spec_invalid", `spec is not a valid ${input.kind} spec: ${formatIssues(specParsed.error.issues)}`, SPEC_HINTS[input.kind]);
    const spec = specParsed.data;

    const vctx: KindValidateContext = { scope, catalog, name: input.name, inputSchema: callerSchema };
    const validation = await kind.validate(spec, vctx);
    if (!validation.ok) return fail(validation.code, validation.message, validation.hint);

    const finalSchema = callerSchema ?? validation.inputSchema ?? { ...DEFAULT_INPUT_SCHEMA };
    if (callerSchema === undefined && validation.inputSchema) {
      const err = validateInputSchema(finalSchema);
      if (err) return fail("schema_invalid", `The input schema derived by the ${input.kind} kind is not usable here: ${err.message}`, "Pass input_schema explicitly.");
    }
    const annotations: ToolAnnotations = { ...kind.defaultAnnotations(spec, vctx), ...(validation.annotations ?? {}), ...(input.annotations ?? {}) };

    if (input.promote) {
      const alreadyPromoted = !!existing && existing.state.promoted && existing.state.decidedBy.promoted === "deploy";
      if (!alreadyPromoted && catalog.budget.usedDeploy >= catalog.budget.limit) {
        const holders = [...catalog.tools.values()].filter((t) => t.kind !== "builtin" && t.state.promoted && t.state.decidedBy.promoted === "deploy").map((t) => t.name).sort();
        return fail("slot_budget_exceeded", `The deploy layer already lists ${catalog.budget.usedDeploy} of ${catalog.budget.limit} defined tools: ${holders.join(", ") || "(none)"}.`,
          "Define without promote (the tool stays callable via call_tool), demote_tool one of them, or raise promoted_budget.", { scope: "deploy", used: catalog.budget.usedDeploy, limit: catalog.budget.limit, promoted: holders });
      }
    }

    const actor = actorOf(exec);
    const row: ToolDefInput = {
      name: input.name, kind: input.kind, title: input.title ?? validation.title ?? input.name, description: input.description,
      input_schema: JSON.stringify(finalSchema), spec: JSON.stringify(spec), annotations: JSON.stringify(annotations), created_by: actor
    };
    if (replacing) await replaceDef(scope.env.DB, row, actor, input.promote);
    else await insertDef(scope.env.DB, row, input.promote, actor);
    notifyToolsChanged();

    const after = await reresolve(exec);
    const resolved = after.tools.get(input.name);
    const visible = !!resolved && resolved.state.enabled && resolved.state.promoted;
    const warnings = [...validation.warnings, ...after.warnings.filter((w) => w.includes(`definition ${input.name} `))];
    const cc = claudeCodeName(after.identity.name, input.name);
    const text =
      `${replacing ? "Replaced" : "Defined"} \`${input.name}\` (${input.kind}). Callable now via call_tool {name:"${input.name}"}. ` +
      (visible ? `Listed in tools/list as ${cc}.` : "Not listed until promote_tool.") +
      (warnings.length ? `\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "");
    return withRefreshHint(ok(text, { name: input.name, kind: input.kind, visible, claudeCodeName: cc, warnings, version: resolved?.def?.version ?? 1, catalogVersion: after.catalogVersion }));
  })
};

export const forgeTools: BuiltinSpec[] = [defineTool];
