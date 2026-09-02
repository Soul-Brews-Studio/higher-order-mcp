// src/util/template.ts [C] — the §12.2 template language used by every define_tool kind.
//
//   {{expr}}          → stringified (string as-is, number/boolean via String, object/array as JSON; missing → "" + warning)
//   {{json expr}}     → JSON.stringify(value)
//   {{= expr}}        → in renderValue, a whole-string tag yields the raw typed value (numbers, objects, arrays …)
//   {{secret:NAME}}   → env["HOMCP_SECRET_" + NAME] (NAME ^[A-Z][A-Z0-9_]*$), only where opts.allowSecret (http url/headers)
//
// Roots: input.<key>[.path] · steps.<id>.text|structured[.path]|isError · principal.clientKey · identity.name · now.iso|date.
// Path segments follow src/util/json-path.ts (`a.b[0].c`). An unknown root or field throws TemplateError (code spec_invalid)
// at any time — define_tool dry-renders with `{}` input so the error surfaces before the definition is stored.
import type { Identity, Principal, RequestScope, ResolvedCatalog } from "../types";
import { getSegments, parsePath, JsonPathError, type PathSegment } from "./json-path";

export interface StepResult { text: string; structured?: unknown; isError: boolean }
export interface RenderContext {
  input: Record<string, unknown>;
  steps: Record<string, StepResult>;
  identity: Identity;
  principal: Principal;
  now: { iso: string; date: string };
  /** Resolves `{{secret:NAME}}`; undefined when the secret is not set. */
  secret?: (name: string) => string | undefined;
}
export interface RenderOptions {
  /** Permit `{{secret:NAME}}` (http url/headers only). Default false. */
  allowSecret?: boolean;
  /** Collects non-fatal warnings (missing values). Deduplicated. */
  warnings?: string[];
  /** Define-time dry render: missing `input.*` / `steps.*` values are expected and stay silent. */
  dry?: boolean;
}

export class TemplateError extends Error {
  readonly code = "spec_invalid" as const;
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const TAG_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const WHOLE_RAW_RE = /^\s*\{\{=\s*([^{}]+?)\s*\}\}\s*$/;
const PRINCIPAL_FIELDS = new Set(["clientKey", "via", "clientName", "clientId"]);
const IDENTITY_FIELDS = new Set(["name", "title", "description"]);
const NOW_FIELDS = new Set(["iso", "date"]);
const STEP_FIELDS = new Set(["text", "structured", "isError"]);

function warn(opts: RenderOptions | undefined, message: string): void {
  if (!opts?.warnings) return;
  if (!opts.warnings.includes(message)) opts.warnings.push(message);
}

function splitRoot(expr: string): { root: string; rest: PathSegment[] } {
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*)(.*)$/s.exec(expr);
  if (!m) throw new TemplateError(`template expression '${expr}' is malformed.`, "Use input.<key>, steps.<id>.text, principal.clientKey, identity.name, now.iso or now.date.");
  const root = m[1]!;
  let tail = m[2]!;
  if (tail.startsWith(".")) tail = tail.slice(1);
  else if (tail !== "" && !tail.startsWith("[")) throw new TemplateError(`template expression '${expr}' is malformed.`);
  let rest: PathSegment[];
  try { rest = parsePath(tail); }
  catch (e) { throw new TemplateError(`template expression '${expr}': ${e instanceof JsonPathError ? e.message : String(e)}`); }
  return { root, rest };
}

/** Evaluates one expression. `missing` is true when the value is absent (undefined). Throws TemplateError on unknown roots/fields. */
export function evaluate(expr: string, ctx: RenderContext, opts?: RenderOptions): { value: unknown; missing: boolean; kind: "input" | "steps" | "static" } {
  const e = expr.trim();
  if (e === "") throw new TemplateError("empty template expression '{{}}'.");
  const { root, rest } = splitRoot(e);
  switch (root) {
    case "input": {
      const value = getSegments(ctx.input, rest);
      return { value, missing: value === undefined, kind: "input" };
    }
    case "steps": {
      const [id, field, ...path] = rest;
      if (typeof id !== "string") throw new TemplateError(`'${e}': steps.<id> needs a step id.`);
      if (field !== undefined && (typeof field !== "string" || !STEP_FIELDS.has(field)))
        throw new TemplateError(`'${e}': steps.${id}.${String(field)} is not one of text, structured, isError.`);
      const step = ctx.steps[id];
      if (!step) return { value: undefined, missing: true, kind: "steps" };
      if (field === undefined) return { value: step, missing: false, kind: "steps" };
      if (field === "isError") return { value: step.isError, missing: false, kind: "steps" };
      if (field === "text") return { value: step.text, missing: step.text === undefined, kind: "steps" };
      const value = getSegments(step.structured, path);
      return { value, missing: value === undefined, kind: "steps" };
    }
    case "principal": {
      const [field, ...more] = rest;
      if (typeof field !== "string" || !PRINCIPAL_FIELDS.has(field) || more.length)
        throw new TemplateError(`'${e}': principal exposes only ${[...PRINCIPAL_FIELDS].join(", ")}.`);
      const value = (ctx.principal as unknown as Record<string, unknown>)[field];
      return { value, missing: value === undefined, kind: "static" };
    }
    case "identity": {
      const [field, ...more] = rest;
      if (typeof field !== "string" || !IDENTITY_FIELDS.has(field) || more.length)
        throw new TemplateError(`'${e}': identity exposes only ${[...IDENTITY_FIELDS].join(", ")}.`);
      const value = (ctx.identity as unknown as Record<string, unknown>)[field];
      return { value, missing: value === undefined, kind: "static" };
    }
    case "now": {
      const [field, ...more] = rest;
      if (typeof field !== "string" || !NOW_FIELDS.has(field) || more.length)
        throw new TemplateError(`'${e}': now exposes only iso and date.`);
      return { value: ctx.now[field as "iso" | "date"], missing: false, kind: "static" };
    }
    default:
      throw new TemplateError(`unknown template root '${root}' in '{{${e}}}'.`, "Roots: input, steps, principal, identity, now (and {{secret:NAME}} in http url/headers).");
  }
}

function resolveSecret(name: string, ctx: RenderContext, opts?: RenderOptions): string {
  if (!opts?.allowSecret) throw new TemplateError(`{{secret:${name}}} is only allowed in http url and headers.`, "Secrets never enter tool text, bodies, bind values or compose args.");
  if (!SECRET_NAME_RE.test(name)) throw new TemplateError(`secret name '${name}' must match ${SECRET_NAME_RE}.`);
  const value = ctx.secret?.(name);
  if (value === undefined || value === "") throw new TemplateError(`secret ${name} is not set.`, `Run: wrangler secret put HOMCP_SECRET_${name}`);
  return value;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

function noteMissing(expr: string, kind: "input" | "steps" | "static", opts?: RenderOptions): void {
  if (opts?.dry && kind !== "static") return;
  warn(opts, `{{${expr}}} is empty`);
}

/** Parses the inside of a tag into its form. */
function classify(inner: string): { form: "text" | "json" | "raw" | "secret"; expr: string } {
  const s = inner.trim();
  if (s.startsWith("secret:")) return { form: "secret", expr: s.slice("secret:".length).trim() };
  if (s.startsWith("=")) return { form: "raw", expr: s.slice(1).trim() };
  const json = /^json\s+(.+)$/s.exec(s);
  if (json) return { form: "json", expr: json[1]!.trim() };
  return { form: "text", expr: s };
}

/** Renders a text template. Throws TemplateError (spec_invalid) on unknown roots, disallowed secrets or malformed tags. */
export function render(template: string, ctx: RenderContext, opts?: RenderOptions): string {
  return template.replace(TAG_RE, (_m, inner: string) => {
    const { form, expr } = classify(inner);
    if (form === "secret") return resolveSecret(expr, ctx, opts);
    const r = evaluate(expr, ctx, opts);
    if (r.missing) noteMissing(expr, r.kind, opts);
    if (form === "json") return r.missing ? "null" : JSON.stringify(r.value);
    return stringify(r.value);
  });
}

/**
 * Renders a JSON-ish value: strings are templates (a whole-string `{{= expr}}` yields the raw typed value),
 * arrays/objects recurse, other scalars pass through. Keys are never rendered. Undefined values drop out of objects.
 */
export function renderValue(value: unknown, ctx: RenderContext, opts?: RenderOptions): unknown {
  if (typeof value === "string") {
    const raw = WHOLE_RAW_RE.exec(value);
    if (raw) {
      const inner = raw[1]!.trim();
      if (inner.startsWith("secret:")) return resolveSecret(inner.slice("secret:".length).trim(), ctx, opts);
      const r = evaluate(inner, ctx, opts);
      if (r.missing) noteMissing(inner, r.kind, opts);
      return r.value;
    }
    return render(value, ctx, opts);
  }
  if (Array.isArray(value)) return value.map((v) => renderValue(v, ctx, opts));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const rv = renderValue(v, ctx, opts);
      if (rv !== undefined) out[k] = rv;
    }
    return out;
  }
  return value;
}

/** Every `{{secret:NAME}}` referenced anywhere inside a value (strings are scanned; objects/arrays recurse). */
export function secretRefs(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") { for (const m of v.matchAll(/\{\{\s*secret:\s*([^{}\s]+)\s*\}\}/g)) names.add(m[1]!); }
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return [...names];
}

/** Every `input.<key>` referenced inside a value (top-level key only) — used to warn about undeclared parameters. */
export function inputRefs(value: unknown): string[] {
  const keys = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") { for (const m of v.matchAll(/\{\{[^{}]*?\binput\.([A-Za-z0-9_$-]+)/g)) keys.add(m[1]!); }
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return [...keys];
}

/** Every `steps.<id>` referenced inside a value — compose validation checks ids exist and precede the step. */
export function stepRefs(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") { for (const m of v.matchAll(/\{\{[^{}]*?\bsteps\.([A-Za-z0-9_]+)/g)) ids.add(m[1]!); }
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  return [...ids];
}

export function nowParts(d: Date = new Date()): { iso: string; date: string } {
  const iso = d.toISOString();
  return { iso, date: iso.slice(0, 10) };
}

/** Builds the render context for a request: env secrets, identity from the catalog, principal from the scope. */
export function contextFor(scope: RequestScope, catalog: ResolvedCatalog, input: Record<string, unknown> = {}, steps: Record<string, StepResult> = {}): RenderContext {
  return {
    input, steps,
    identity: catalog.identity,
    principal: scope.principal,
    now: nowParts(),
    secret: (name) => scope.env[`HOMCP_SECRET_${name}`]
  };
}
