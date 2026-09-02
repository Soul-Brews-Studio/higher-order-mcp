// src/registry/kinds/http.ts [C] — kind "http": one https request per call under a host allow-list (§12.3).
// Define-time: https only; host is a DNS name (no literal IP / localhost / *.internal / *.local / *.home.arpa); no `{{` in
// the host part; allowed_hosts defaults to [url host]; every {{secret:NAME}} must resolve; dry render.
// Runtime: render url/headers/body; re-check https + host ∈ allowed_hosts (http_blocked_host); fetch with redirect:"manual"
// and AbortSignal.timeout(timeout_ms); read ≤ max_bytes then abort (http_too_large note); non-2xx → http_failed {status}
// + first 2 KB; json/auto parses → structuredContent (optionally json_path); timeout → http_timeout.
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { specHttp } from "../../mcp/schemas";
import { ok, fail } from "../../mcp/result";
import { checkHttpsUrl, hostPolicyError, outbound } from "../upstream";
import { contextFor, render, renderValue, secretRefs, TemplateError } from "../../util/template";
import { get as jsonPathGet, parsePath, JsonPathError } from "../../util/json-path";
import { undeclaredInputWarnings, withHomcpMeta } from "./template";
import type { ExecContext, KindModule, KindValidateContext, KindValidation, ResolvedTool, ToolAnnotations } from "../../types";

export type SpecHttp = z.infer<typeof specHttp>;

const ERROR_BODY_PREVIEW = 2048;

function normalizeHost(h: string): string { return h.trim().toLowerCase().replace(/\.$/, ""); }

/** The effective allow-list: explicit `allowed_hosts` (validated) or the url host. */
export function effectiveAllowedHosts(spec: SpecHttp, urlHost: string): string[] {
  const list = (spec.allowed_hosts?.length ? spec.allowed_hosts : [urlHost]).map(normalizeHost);
  return [...new Set(list)];
}

export const httpKind: KindModule<SpecHttp> = {
  kind: "http",
  specSchema: specHttp,
  async validate(spec: SpecHttp, ctx: KindValidateContext): Promise<KindValidation> {
    const warnings: string[] = [];
    const checked = checkHttpsUrl(spec.url);
    if ("error" in checked) return { ok: false, code: "spec_invalid", message: `url: ${checked.error}.`, hint: "http tools call one https:// URL on a public DNS name; parameters may only appear in the path, query, headers and body." };
    const urlHost = normalizeHost(checked.url.hostname);
    if (spec.allowed_hosts) {
      for (const h of spec.allowed_hosts) {
        const reason = hostPolicyError(h);
        if (reason) return { ok: false, code: "spec_invalid", message: `allowed_hosts: ${reason}.` };
      }
      if (!spec.allowed_hosts.map(normalizeHost).includes(urlHost)) return { ok: false, code: "spec_invalid", message: `allowed_hosts must include the url host '${urlHost}'.` };
    }
    if (spec.method === "GET" && spec.body !== undefined) return { ok: false, code: "spec_invalid", message: "GET requests cannot carry a body.", hint: "Use method POST/PUT/PATCH, or put parameters in the query string." };
    if (spec.body !== undefined && secretRefs(spec.body).length) return { ok: false, code: "spec_invalid", message: "{{secret:NAME}} is only allowed in url and headers, not in the body." };
    if (spec.json_path !== undefined) {
      try { parsePath(spec.json_path); }
      catch (e) { return { ok: false, code: "spec_invalid", message: `json_path: ${e instanceof JsonPathError ? e.message : String(e)}` }; }
      if (spec.response === "text") warnings.push("json_path is ignored when response is \"text\"");
    }
    const rctx = contextFor(ctx.scope, ctx.catalog);
    try {
      render(spec.url, rctx, { warnings, dry: true, allowSecret: true });
      renderValue(spec.headers, rctx, { warnings, dry: true, allowSecret: true });
      if (spec.body !== undefined) renderValue(spec.body, rctx, { warnings, dry: true });
    } catch (e) {
      if (e instanceof TemplateError) return { ok: false, code: "spec_invalid", message: e.message, hint: e.hint };
      return { ok: false, code: "spec_invalid", message: String(e) };
    }
    try { new Headers(Object.fromEntries(Object.keys(spec.headers).map((k) => [k, "x"]))); }
    catch (e) { return { ok: false, code: "spec_invalid", message: `headers: ${String(e).slice(0, 200)}` }; }
    warnings.push(...undeclaredInputWarnings([spec.url, spec.headers, spec.body ?? ""], ctx.inputSchema));
    return { ok: true, warnings };
  },
  defaultAnnotations(spec: SpecHttp): ToolAnnotations {
    const m = spec.method;
    return { readOnlyHint: m === "GET", destructiveHint: m === "DELETE" || m === "PUT" || m === "PATCH", idempotentHint: m !== "POST", openWorldHint: true };
  },
  async run(tool: ResolvedTool, input: Record<string, unknown>, exec: ExecContext): Promise<CallToolResult> {
    const parsed = specHttp.safeParse(tool.spec);
    if (!parsed.success) return fail("spec_invalid", `Definition '${tool.name}' has an invalid http spec.`, "describe_tool shows the stored spec; define_tool {replace:true} fixes it.");
    const spec = parsed.data;
    const warnings: string[] = [];
    const rctx = contextFor(exec.scope, exec.catalog, input);

    // 1. render
    let url: string; let headers: Headers; let body: BodyInit | undefined;
    try {
      url = render(spec.url, rctx, { warnings, allowSecret: true });
      headers = new Headers(renderValue(spec.headers, rctx, { warnings, allowSecret: true }) as Record<string, string>);
      if (spec.body !== undefined) {
        if (typeof spec.body === "string") body = render(spec.body, rctx, { warnings });
        else { body = JSON.stringify(renderValue(spec.body, rctx, { warnings })); if (!headers.has("content-type")) headers.set("content-type", "application/json"); }
      }
    } catch (e) {
      if (e instanceof TemplateError) return fail("spec_invalid", e.message, e.hint);
      throw e;
    }

    // 2. re-check the rendered target
    let target: URL;
    try { target = new URL(url); } catch { return fail("http_blocked_host", "The rendered URL is not valid.", "Parameters may only appear in the path, query, headers and body."); }
    const defined = checkHttpsUrl(spec.url);
    if ("error" in defined) return fail("http_blocked_host", `The definition's url is not allowed: ${defined.error}.`, "define_tool {replace:true} with an https:// URL on a public DNS name.");
    const allowed = effectiveAllowedHosts(spec, normalizeHost(defined.url.hostname));
    const host = normalizeHost(target.hostname);
    const reason = target.protocol !== "https:" ? "only https:// is allowed" : !allowed.includes(host) ? `'${host}' is not in allowed_hosts [${allowed.join(", ")}]` : hostPolicyError(host);
    if (reason || target.username || target.password) return fail("http_blocked_host", `Refusing to call ${host || "the rendered URL"}: ${reason ?? "credentials in the URL are not allowed"}.`, "Rendered URLs must stay on the hosts the definition allows.");

    // 3. fetch
    let res: Response;
    const started = Date.now();
    try {
      res = await outbound.fetch(target.toString(), { method: spec.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(spec.timeout_ms) });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") return fail("http_timeout", `${spec.method} ${host} did not answer within ${spec.timeout_ms} ms.`, "Raise timeout_ms (max 25000) or fix the upstream.");
      return fail("http_failed", `${spec.method} ${host} failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
    }

    // 4. read ≤ max_bytes
    let truncated = false;
    let bytes: Uint8Array;
    try {
      const out = await readCapped(res, spec.max_bytes, spec.timeout_ms - (Date.now() - started));
      bytes = out.bytes; truncated = out.truncated;
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") return fail("http_timeout", `${spec.method} ${host}: reading the response exceeded ${spec.timeout_ms} ms.`);
      return fail("http_failed", `${spec.method} ${host}: could not read the response: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
    }
    const text = new TextDecoder().decode(bytes);
    const contentType = res.headers.get("content-type") ?? "";
    const meta: Record<string, unknown> = { status: res.status, contentType, bytes: bytes.byteLength, truncated };

    // 5. status
    if (res.status < 200 || res.status >= 300) {
      const location = res.headers.get("location");
      return withHomcpMeta(fail("http_failed", `${spec.method} ${host} returned HTTP ${res.status}${location ? ` (redirect to ${new URL(location, target).host} not followed)` : ""}.`, undefined, { status: res.status, ...(location ? { location } : {}), body: text.slice(0, ERROR_BODY_PREVIEW) }), meta);
    }

    // 6. shape
    const looksJson = /\bjson\b/i.test(contentType) || /^\s*[[{]/.test(text);
    const wantJson = spec.response === "json" || (spec.response === "auto" && looksJson);
    if (wantJson) {
      let value: unknown;
      try { value = JSON.parse(text); }
      catch (e) {
        if (truncated) return withHomcpMeta(fail("http_too_large", `${host} answered with more than max_bytes (${spec.max_bytes}) of JSON; the truncated document cannot be parsed.`, "Raise max_bytes (max 262144) or narrow the request."), meta);
        if (spec.response === "json") return withHomcpMeta(fail("http_failed", `${host} did not return valid JSON: ${String(e).slice(0, 200)}`, undefined, { body: text.slice(0, ERROR_BODY_PREVIEW) }), meta);
        return finish(ok(noteTruncated(text, truncated, spec.max_bytes)), meta, warnings);
      }
      let picked = value;
      if (spec.json_path) {
        picked = jsonPathGet(value, spec.json_path);
        if (picked === undefined) warnings.push(`json_path '${spec.json_path}' matched nothing`);
      }
      const structured = picked && typeof picked === "object" && !Array.isArray(picked) ? (picked as Record<string, unknown>) : { value: picked ?? null };
      const rendered = typeof picked === "string" ? picked : JSON.stringify(picked ?? null, null, 2);
      return finish(ok(noteTruncated(rendered, truncated, spec.max_bytes), structured), meta, warnings);
    }
    return finish(ok(noteTruncated(text, truncated, spec.max_bytes)), meta, warnings);
  }
};

function noteTruncated(text: string, truncated: boolean, max: number): string {
  return truncated ? `${text}\n\n[http_too_large: response exceeded max_bytes (${max}); truncated]` : text;
}
function finish(r: CallToolResult, meta: Record<string, unknown>, warnings: string[]): CallToolResult {
  return withHomcpMeta(r, warnings.length ? { ...meta, warnings } : meta);
}

/** Reads a response body up to `max` bytes; cancels the stream and reports `truncated` beyond that. */
export async function readCapped(res: Response, max: number, remainingMs: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const deadline = Date.now() + Math.max(remainingMs, 250);
  try {
    for (;;) {
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) { const err = new Error("read timeout"); err.name = "TimeoutError"; throw err; }
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => { const err = new Error("read timeout"); err.name = "TimeoutError"; reject(err); }, timeLeft))
      ]);
      if (next.done) break;
      const chunk = next.value;
      if (total + chunk.byteLength > max) { chunks.push(chunk.subarray(0, max - total)); total = max; truncated = true; break; }
      chunks.push(chunk); total += chunk.byteLength;
    }
  } finally {
    if (truncated) reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  return { bytes, truncated };
}
