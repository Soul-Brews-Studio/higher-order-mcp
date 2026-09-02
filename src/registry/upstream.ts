// src/registry/upstream.ts [C] — §12.4 verbatim: the outbound fetch seam, per-call MCP Client, hop header, redaction.
// One `Client` per call, never cached. Hop guard: `X-Homcp-Hop = scope.hop + 1` on every upstream request; parsed at the
// `/mcp` entry (src/mcp/handler.ts); `invoke()` refuses every call when `scope.hop >= MAX_HOP (3)` with `hop_limit`.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { VERSION } from "../version";
import type { RequestScope, UpstreamRow } from "../types";
export const outbound = { fetch: globalThis.fetch.bind(globalThis) as typeof fetch };   // tests: outbound.fetch = (i, init) => SELF.fetch(i, init)
export function upstreamHeaders(up: UpstreamRow, scope: RequestScope): Headers {
  const h = new Headers(JSON.parse(up.headers || "{}"));
  const token = up.auth_kind === "bearer" ? up.auth_value : up.auth_kind === "secret" && up.auth_value ? scope.env[`HOMCP_SECRET_${up.auth_value}`] : undefined;
  if (token) h.set("authorization", `Bearer ${token}`);
  h.set("x-homcp-hop", String(scope.hop + 1));
  return h;
}
export async function withUpstream<T>(scope: RequestScope, up: UpstreamRow, fn: (c: Client) => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("upstream_timeout")), timeoutMs + 10_000);
  const transport = new StreamableHTTPClientTransport(new URL(up.url), { requestInit: { headers: upstreamHeaders(up, scope), signal: ac.signal }, fetch: outbound.fetch });
  const client = new Client({ name: "homcp", version: VERSION }, { capabilities: {}, versionNegotiation: { mode: "auto" } });   // server/discover first, legacy fallback
  try { await client.connect(transport, { timeout: 10_000 }); return await fn(client); }
  finally { clearTimeout(timer); await client.close().catch(() => {}); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Host policy (shared by the http kind and add_upstream): https only, DNS names only — no literal IPv4/IPv6, no
// localhost / *.localhost / *.internal / *.local / *.home.arpa, no single-label hosts.
// ---------------------------------------------------------------------------------------------------------------------
const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local", ".home.arpa"];
/** null when the hostname is acceptable, else a human-readable reason. */
export function hostPolicyError(hostname: string): string | null {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return "host is empty";
  if (h.startsWith("[") || h.includes(":")) return `'${hostname}' is a literal IPv6 address`;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return `'${hostname}' is a literal IPv4 address`;
  if (/^[\d.]+$/.test(h)) return `'${hostname}' is not a DNS name`;
  if (h === "localhost") return "'localhost' is not allowed";
  for (const suffix of BLOCKED_SUFFIXES) if (h.endsWith(suffix)) return `'${hostname}' (${suffix.slice(1)} zone) is not allowed`;
  if (h === "internal" || h === "local" || h === "home.arpa") return `'${hostname}' is not allowed`;
  if (!h.includes(".")) return `'${hostname}' is a single-label host; use a fully qualified DNS name`;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)) return `'${hostname}' is not a valid DNS name`;
  return null;
}
/** Parses an upstream / http URL under the policy. Returns the URL or a reason string. */
export function checkHttpsUrl(raw: string): { url: URL } | { error: string } {
  const hostPart = /^https?:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  if (hostPart.includes("{{") || hostPart.includes("}}")) return { error: "placeholders are not allowed in the host part of the url" };
  let url: URL;
  try { url = new URL(raw); } catch { return { error: `'${raw}' is not a valid URL` }; }
  if (url.protocol !== "https:") return { error: "only https:// URLs are allowed" };
  if (url.username || url.password) return { error: "credentials in the URL are not allowed" };
  const reason = hostPolicyError(url.hostname);
  if (reason) return { error: reason };
  return { url };
}

// ---------------------------------------------------------------------------------------------------------------------
// Redaction — nothing that leaves the server may carry auth_value or raw header values.
// ---------------------------------------------------------------------------------------------------------------------
const SENSITIVE_HEADER = /authorization|token|secret|key|cookie|passw/i;
export interface RedactedUpstream {
  name: string; url: string; auth_kind: UpstreamRow["auth_kind"]; auth: string;
  headers: Record<string, string>; server_info: unknown; cached_at: string | null; tool_count: number | null;
  created_by: string; created_at: string;
}
export type UpstreamLike = Omit<UpstreamRow, "auth_value" | "tool_cache"> & Partial<Pick<UpstreamRow, "auth_value" | "tool_cache">>;
export function redactUpstream(up: UpstreamLike): RedactedUpstream {
  let headers: Record<string, string> = {};
  try { headers = JSON.parse(up.headers || "{}") as Record<string, string>; } catch { headers = {}; }
  const redactedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) redactedHeaders[k] = SENSITIVE_HEADER.test(k) ? "•••" : String(v);
  let serverInfo: unknown = null;
  try { serverInfo = up.server_info ? JSON.parse(up.server_info) : null; } catch { serverInfo = up.server_info; }
  let toolCount: number | null = null;
  if (up.tool_cache !== undefined) {
    try { const parsed = JSON.parse(up.tool_cache ?? "null"); toolCount = Array.isArray(parsed) ? parsed.length : null; } catch { toolCount = null; }
  }
  const auth = up.auth_kind === "none" ? "none" : up.auth_kind === "bearer" ? "bearer (••• stored in D1 — prefer kind:secret)" : `secret HOMCP_SECRET_${up.auth_value ?? "?"}`;
  return { name: up.name, url: up.url, auth_kind: up.auth_kind, auth, headers: redactedHeaders, server_info: serverInfo, cached_at: up.cached_at, tool_count: toolCount, created_by: up.created_by, created_at: up.created_at };
}

/** Cached tools/list entries as stored in upstreams.tool_cache. */
export interface CachedTool { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }
export function parseToolCache(raw: string | null | undefined): CachedTool[] | null {
  if (!raw) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? (v as CachedTool[]) : null; } catch { return null; }
}

/** Marks an error thrown by the upstream *call* (after a successful connect) so callers can tell it from connect failures. */
export class UpstreamCallError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "UpstreamCallError";
  }
}
/** One-line, secret-free description of an upstream failure. */
export function describeUpstreamError(e: unknown): string {
  if (e instanceof UpstreamCallError) return describeUpstreamError(e.cause);
  if (e && typeof e === "object") {
    const anyE = e as { name?: string; code?: unknown; message?: string; status?: number };
    const parts: string[] = [];
    if (anyE.name && anyE.name !== "Error") parts.push(anyE.name);
    if (anyE.code !== undefined) parts.push(String(anyE.code));
    if (anyE.status !== undefined) parts.push(`HTTP ${anyE.status}`);
    const msg = (anyE.message ?? String(e)).replace(/Bearer\s+\S+/gi, "Bearer •••").slice(0, 300);
    return parts.length ? `${parts.join(" ")}: ${msg}` : msg;
  }
  return String(e).slice(0, 300);
}
