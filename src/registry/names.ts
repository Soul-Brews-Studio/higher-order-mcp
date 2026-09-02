// src/registry/names.ts [B] — tool / upstream name rules and the input_schema guard (§9 D9, §10.3).
import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import type { ErrorCode, ResolvedCatalog } from "../types";

/** No '.', Claude Code sanitizes it to '_' (GAP E2); leading letter; max 64. */
export const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** add_upstream names (§11). */
export const UPSTREAM_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** input_schema property names. */
export const PROPERTY_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_SCHEMA_BYTES = 8192;
export const MAX_SCHEMA_DEPTH = 4;

export interface NameProblem { code: ErrorCode; message: string; hint?: string }

/** `mcp__<key>__<tool>` must stay <= 128 chars (GAP E9/E10); the identity is the suggested key, so it pays for the budget. */
export function nameBudget(identityName: string): number { return Math.min(64, 121 - identityName.length); }

const RESERVED = new Set(["mcp", "tools", "call", "list"]);

export function validateToolName(name: string, catalog: ResolvedCatalog, opts: { replace?: boolean } = {}): NameProblem | null {
  if (!TOOL_NAME_RE.test(name)) return { code: "invalid_name", message: `'${name}' is not a valid tool name.`, hint: "Start with a letter; letters, digits, '_' or '-'; max 64 chars; no dots." };
  if (name.startsWith("mcp__") || RESERVED.has(name)) return { code: "invalid_name", message: `'${name}' is reserved.` };
  const budget = nameBudget(catalog.identity.name);
  if (name.length > budget) return { code: "name_too_long", message: `'${name}' is ${name.length} chars; budget for identity '${catalog.identity.name}' is ${budget}.`, hint: "mcp__<key>__<tool> must stay <= 128 characters or the Claude API rejects every request that includes it." };
  const existing = catalog.tools.get(name);
  if (existing && (existing.kind === "builtin" || !opts.replace)) return { code: "name_taken", message: `'${name}' is already ${existing.kind === "builtin" ? "a built-in tool" : `a ${existing.kind} tool`}.`, hint: existing.kind === "builtin" ? "Pick another name." : "Pass replace:true to update it in place." };
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const SUBSCHEMA_ONE = ["items", "additionalProperties", "not", "contains", "propertyNames", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"] as const;
const SUBSCHEMA_LISTS = ["prefixItems", "anyOf", "oneOf", "allOf"] as const;

/** Nesting depth in schema nodes: the root is 1, a property schema 2, its property schema 3, ... */
export function schemaDepth(node: unknown): number {
  if (!isPlainObject(node)) return 0;
  let max = 1;
  const sub = (child: unknown) => { const d = schemaDepth(child); if (d > 0) max = Math.max(max, 1 + d); };
  for (const key of SUBSCHEMA_MAPS) { const m = node[key]; if (isPlainObject(m)) for (const v of Object.values(m)) sub(v); }
  for (const key of SUBSCHEMA_ONE) { const v = node[key]; if (Array.isArray(v)) { for (const x of v) sub(x); } else sub(v); }
  for (const key of SUBSCHEMA_LISTS) { const v = node[key]; if (Array.isArray(v)) for (const x of v) sub(x); }
  return max;
}

const EXAMPLE = 'Example: {"type":"object","properties":{"project":{"type":"string"}},"required":["project"],"additionalProperties":false}';

/**
 * §10.3: a JSON object with type:"object"; no anyOf/oneOf/allOf/$ref at the root; property names PROPERTY_NAME_RE;
 * serialized <= 8192 bytes; depth <= 4; must compile through the SDK's fromJsonSchema and validate({}) must not throw.
 */
export function validateInputSchema(schema: unknown): NameProblem | null {
  const bad = (message: string, hint: string = EXAMPLE): NameProblem => ({ code: "schema_invalid", message, hint });
  if (!isPlainObject(schema)) return bad("input_schema must be a JSON object.");
  if (schema.type !== "object") return bad('input_schema.type must be "object".', "Tool arguments are always one object; put each argument under properties.");
  for (const key of ["anyOf", "oneOf", "allOf", "$ref"]) if (key in schema) return bad(`input_schema must not use ${key} at the root.`, "Describe one flat object; combinators are allowed inside individual properties.");
  if ("properties" in schema) {
    if (!isPlainObject(schema.properties)) return bad("input_schema.properties must be an object.");
    for (const key of Object.keys(schema.properties)) {
      if (!PROPERTY_NAME_RE.test(key)) return bad(`property name '${key}' is not allowed.`, "Use letters, digits, '_', '.' or '-' (1-64 chars).");
    }
  }
  let serialized: string;
  try { serialized = JSON.stringify(schema); } catch (e) { return bad(`input_schema is not serializable: ${String(e)}`); }
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > MAX_SCHEMA_BYTES) return bad(`input_schema is ${bytes} bytes; the maximum is ${MAX_SCHEMA_BYTES}.`, "Trim descriptions or split the tool.");
  const depth = schemaDepth(schema);
  if (depth > MAX_SCHEMA_DEPTH) return bad(`input_schema nests ${depth} levels deep; the maximum is ${MAX_SCHEMA_DEPTH}.`, "Flatten nested objects into top-level arguments.");
  try {
    const compiled = fromJsonSchema(JSON.parse(serialized) as JsonSchemaType);
    const r = compiled["~standard"].validate({});
    if (r instanceof Promise) r.catch(() => undefined);
  } catch (e) {
    return bad(`input_schema does not compile: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

/** Returns an error message or null. */
export function validateUpstreamName(name: string): string | null {
  if (typeof name !== "string" || !UPSTREAM_NAME_RE.test(name)) return `'${String(name)}' is not a valid upstream name: lowercase letter first, then lowercase letters, digits, '_' or '-'; max 32 chars.`;
  return null;
}
