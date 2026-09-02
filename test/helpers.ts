// test/helpers.ts [W0] — shared test plumbing (§18). Every request goes through SELF.fetch("https://homcp.test/...");
// pool-workers runs the main Worker in the same isolate as the tests, so `homcp.test` never touches the network
// and module-level seams (e.g. registry/upstream.ts `outbound.fetch`) can be swapped for SELF.fetch.
//
// Bindings come from vitest.config.ts: OWNER_PASSPHRASE="test-passphrase", MCP_API_TOKEN="test-static-token",
// MCP_SERVER_NAME="homcp-test", HOMCP_SECRET_X="s3cret".
//
// Consent form contract assumed by startConsent/submitConsent (workstream A's src/web/consent.tsx must match):
//   hidden <input name="state">, <input name="label">, <input name="passphrase">, and a submit named
//   `action` with value "approve" | "deny" (CONSENT_FIELDS below). Owner console: POST /owner/login with
//   form field `passphrase`, cookie `homcp_owner` (OWNER_COOKIE), every POST same-origin (Origin / Sec-Fetch-Site).
import { SELF } from "cloudflare:test";
import type { CallToolResult } from "@modelcontextprotocol/server";

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------
export const BASE = "https://homcp.test";
export const MCP_URL = `${BASE}/mcp`;
export const TEST_TOKEN = "test-static-token";
export const TEST_PASSPHRASE = "test-passphrase";
export const TEST_IDENTITY = "homcp-test";
export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-06-18";
export const LEGACY_VERSION_NEWER = "2025-11-25";
export const OWNER_COOKIE = "homcp_owner";
export const CONSENT_FIELDS = { state: "state", label: "label", passphrase: "passphrase", action: "action" } as const;

/** The 15 built-ins listed by default (§11), sorted — what tools/list returns on a fresh database. */
export const DEFAULT_VISIBLE_TOOLS = [
  "call_tool", "define_tool", "demote_tool", "describe_tool", "forget_memory", "list_tools", "memory_stats",
  "promote_tool", "read_memory", "recall", "remember", "revise_memory", "server_info", "toggle_tool", "whoami"
].sort();
/** The 7 built-ins hidden by default (§11). */
export const DEFAULT_HIDDEN_TOOLS = [
  "add_upstream", "list_upstreams", "override_tool", "remove_tool", "remove_upstream", "set_identity", "upstream_tools"
].sort();

// ---------------------------------------------------------------------------------------------------------------------
// JSON-RPC over /mcp
// ---------------------------------------------------------------------------------------------------------------------
export type JsonRpcId = number | string;
export interface JsonRpcError { code: number; message: string; data?: unknown }
export interface JsonRpcResponse<T = unknown> { jsonrpc: "2.0"; id: JsonRpcId | null; result?: T; error?: JsonRpcError }
export interface JsonRpcRequest { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> }

export interface McpOptions {
  /** undefined → the static test token; null → no Authorization header; string → that bearer. */
  token?: string | null;
  headers?: Record<string, string>;
  method?: string;
  /** Override the URL (default MCP_URL) — e.g. `${BASE}/mcp/other` for the 404 lock. */
  url?: string;
}

let nextId = 1;
/** A JSON-RPC request body with an auto-incrementing id. */
export function rpc(method: string, params: Record<string, unknown> = {}, id: JsonRpcId = nextId++): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}
/** A JSON-RPC notification body (no id). */
export function notification(method: string, params: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: "2.0", method, params };
}

/** POST (by default) a body to /mcp with Accept for both JSON and SSE. */
export function mcp(body?: unknown, opts: McpOptions = {}): Promise<Response> {
  const token = opts.token === undefined ? TEST_TOKEN : opts.token;
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(opts.headers ?? {})
  };
  return SELF.fetch(opts.url ?? MCP_URL, {
    method: opts.method ?? "POST",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

/** Parses a JSON-RPC response from either a JSON body or the first SSE event's `data:` lines. */
export async function readJsonRpc<T = unknown>(res: Response): Promise<JsonRpcResponse<T>> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const data: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      if (raw.startsWith("data:")) { data.push(raw.slice(5).replace(/^ /, "")); continue; }
      if (raw === "" && data.length > 0) break;                      // end of the first event
    }
    if (data.length === 0) throw new Error(`no data: frame in SSE response (${res.status}): ${text.slice(0, 300)}`);
    return JSON.parse(data.join("\n")) as JsonRpcResponse<T>;
  }
  try { return JSON.parse(text) as JsonRpcResponse<T>; }
  catch { throw new Error(`non-JSON response (${res.status} ${contentType || "no content-type"}): ${text.slice(0, 300)}`); }
}

/** Legacy-lane (2025) `initialize` request body. */
export function legacyInit(version: string = LEGACY_VERSION, id: JsonRpcId = nextId++): JsonRpcRequest {
  return rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "homcp-test-client", version: "0.0.0" } }, id);
}

// ---- modern lane (2026-07-28): per-request envelope + cross-check headers ----
export const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {}
} as const;
export function modernHeaders(method: string): Record<string, string> {
  return { "mcp-protocol-version": MODERN_VERSION, "mcp-method": method };
}
export function modernBody(method: string, params: Record<string, unknown> = {}, id: JsonRpcId = nextId++): JsonRpcRequest {
  const meta = (params._meta && typeof params._meta === "object" ? params._meta : {}) as Record<string, unknown>;
  return rpc(method, { ...params, _meta: { ...MODERN_META, ...meta } }, id);
}
/** Sends one modern-lane request (Mcp-Protocol-Version + Mcp-Method headers, params._meta envelope). */
export function modern(method: string, params: Record<string, unknown> = {}, opts: McpOptions = {}): Promise<Response> {
  return mcp(modernBody(method, params), { ...opts, headers: { ...modernHeaders(method), ...(opts.headers ?? {}) } });
}

// ---- tools ----
export interface ListedTool { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown>; _meta?: Record<string, unknown>; [k: string]: unknown }

export async function toolsList(token?: string | null): Promise<ListedTool[]> {
  const r = await readJsonRpc<{ tools: ListedTool[] }>(await mcp(rpc("tools/list"), { token }));
  if (r.error) throw new Error(`tools/list → JSON-RPC error ${r.error.code}: ${r.error.message}`);
  return r.result?.tools ?? [];
}
/** Sorted tool names as seen by this principal. */
export async function toolNames(token?: string | null): Promise<string[]> {
  return (await toolsList(token)).map((t) => t.name).sort();
}

/** Legacy-lane tools/call; returns the whole JSON-RPC envelope (SDK-level errors such as "Tool X disabled" arrive as `error`). */
export async function callToolRaw(name: string, args: Record<string, unknown> = {}, token?: string | null): Promise<JsonRpcResponse<CallToolResult>> {
  return readJsonRpc<CallToolResult>(await mcp(rpc("tools/call", { name, arguments: args }), { token }));
}
/** Legacy-lane tools/call; returns the CallToolResult (tool-level errors are in the result: isError + structuredContent.error) and throws on a JSON-RPC error. */
export async function callTool(name: string, args: Record<string, unknown> = {}, token?: string | null): Promise<CallToolResult> {
  const r = await callToolRaw(name, args, token);
  if (r.error) throw new Error(`tools/call ${name} → JSON-RPC error ${r.error.code}: ${r.error.message}`);
  if (!r.result) throw new Error(`tools/call ${name} → empty result`);
  return r.result;
}

/** All text content blocks joined with newlines. */
export function textOf(r: CallToolResult): string {
  return (r.content ?? []).filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
}
export function structuredOf<T = Record<string, unknown>>(r: CallToolResult): T {
  return r.structuredContent as T;
}
/** The §12.5 error body when the result is a failure, else undefined. */
export function errorOf(r: CallToolResult): { code: string; message: string; hint?: string; details?: unknown } | undefined {
  const err = (r.structuredContent as { error?: { code: string; message: string; hint?: string; details?: unknown } } | undefined)?.error;
  return r.isError && err ? err : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// OAuth: DCR + PKCE + consent + token
// ---------------------------------------------------------------------------------------------------------------------
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** 43-char S256 verifier/challenge pair. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

export interface RegisteredClient { client_id: string; client_name?: string; redirect_uris: string[]; token_endpoint_auth_method?: string; [k: string]: unknown }
/** Dynamic client registration (public client, loopback redirect). */
export async function registerClient(opts: { clientName?: string; redirectUri: string; extra?: Record<string, unknown> }): Promise<RegisteredClient> {
  const res = await SELF.fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: opts.clientName ?? "Claude Code",
      redirect_uris: [opts.redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(opts.extra ?? {})
    })
  });
  if (res.status !== 201) throw new Error(`DCR failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as RegisteredClient;
}

export interface AuthorizeParams { clientId: string; redirectUri: string; challenge: string; challengeMethod?: string; state?: string; scope?: string; resource?: string }
export function authorizeUrl(p: AuthorizeParams): string {
  const u = new URL(`${BASE}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  if (p.scope !== undefined) u.searchParams.set("scope", p.scope);
  if (p.state !== undefined) u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", p.challengeMethod ?? "S256");
  if (p.resource !== undefined) u.searchParams.set("resource", p.resource);
  return u.toString();
}

function decodeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
/** The hidden `state` value on the consent page. */
export function consentState(html: string): string {
  const m = /<input[^>]*\bname="state"[^>]*\bvalue="([^"]*)"/i.exec(html) ?? /<input[^>]*\bvalue="([^"]*)"[^>]*\bname="state"/i.exec(html);
  if (!m) throw new Error(`consent page has no hidden state input: ${html.slice(0, 300)}`);
  return decodeHtml(m[1]!);
}

export function sameOriginHeaders(contentType?: string): Record<string, string> {
  return { origin: BASE, "sec-fetch-site": "same-origin", ...(contentType ? { "content-type": contentType } : {}) };
}

export interface ConsentStart {
  client: RegisteredClient; redirectUri: string; verifier: string; challenge: string; state: string; url: string;
  page: Response; html: string; formState: string;
}
export interface ConsentOptions { port?: number; clientName?: string; scope?: string; resource?: string | null; state?: string; challengeMethod?: string }
/** DCR + PKCE + GET /authorize. `formState` is the hidden field to post back (empty when the page is not 200). */
export async function startConsent(opts: ConsentOptions = {}): Promise<ConsentStart> {
  const redirectUri = `http://localhost:${opts.port ?? 3118}/callback`;
  const client = await registerClient({ clientName: opts.clientName, redirectUri });
  const { verifier, challenge } = await pkcePair();
  const state = opts.state ?? crypto.randomUUID();
  const url = authorizeUrl({
    clientId: client.client_id, redirectUri, challenge, challengeMethod: opts.challengeMethod, state, scope: opts.scope,
    resource: opts.resource === null ? undefined : (opts.resource ?? MCP_URL)
  });
  const page = await SELF.fetch(url, { redirect: "manual" });
  const html = await page.clone().text();
  const formState = page.status === 200 ? consentState(html) : "";
  return { client, redirectUri, verifier, challenge, state, url, page, html, formState };
}

export interface ConsentSubmit { label?: string; passphrase?: string; action?: "approve" | "deny"; extra?: Record<string, string>; headers?: Record<string, string> }
/** POST /authorize (form-urlencoded, same-origin, no redirect following). */
export function submitConsent(formState: string, opts: ConsentSubmit = {}): Promise<Response> {
  const form = new URLSearchParams({
    [CONSENT_FIELDS.state]: formState,
    [CONSENT_FIELDS.label]: opts.label ?? "claude-code",
    [CONSENT_FIELDS.passphrase]: opts.passphrase ?? TEST_PASSPHRASE,
    [CONSENT_FIELDS.action]: opts.action ?? "approve",
    ...(opts.extra ?? {})
  });
  return SELF.fetch(`${BASE}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { ...sameOriginHeaders("application/x-www-form-urlencoded"), ...(opts.headers ?? {}) },
    body: form.toString()
  });
}

export interface Tokens { access_token: string; refresh_token?: string; token_type?: string; expires_in?: number; scope?: string; resource?: string | string[]; [k: string]: unknown }
async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  const res = await SELF.fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString()
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint ${res.status} (${form.grant_type}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as Tokens;
}
export function exchangeCode(p: { code: string; clientId: string; redirectUri: string; verifier: string; resource?: string }): Promise<Tokens> {
  return tokenRequest({
    grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier,
    ...(p.resource ? { resource: p.resource } : {})
  });
}
export function refreshTokens(refreshToken: string, clientId: string, resource?: string): Promise<Tokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, ...(resource ? { resource } : {}) });
}

export interface DanceOptions extends ConsentOptions { label?: string; passphrase?: string }
export interface DanceResult { accessToken: string; refreshToken?: string; tokens: Tokens; clientId: string; redirectUri: string; verifier: string; label: string; code: string }
/**
 * Full OAuth dance: DCR (token_endpoint_auth_method "none") → GET /authorize → POST approve with the owner passphrase →
 * 302 with `code` → /oauth/token (S256). Returns the bearer for `mcp(body, { token: accessToken })`.
 */
export async function oauthDance(opts: DanceOptions = {}): Promise<DanceResult> {
  const start = await startConsent(opts);
  if (start.page.status !== 200) throw new Error(`GET /authorize → ${start.page.status}: ${start.html.slice(0, 300)}`);
  const label = opts.label ?? "claude-code";
  const approved = await submitConsent(start.formState, { label, passphrase: opts.passphrase, action: "approve" });
  if (approved.status !== 302) throw new Error(`POST /authorize → ${approved.status}: ${(await approved.text()).slice(0, 300)}`);
  const location = new URL(approved.headers.get("location") ?? "");
  const code = location.searchParams.get("code");
  if (!code) throw new Error(`approval redirect has no code: ${location.toString()}`);
  if (location.searchParams.get("state") !== start.state) throw new Error(`state mismatch on redirect: ${location.toString()}`);
  const tokens = await exchangeCode({ code, clientId: start.client.client_id, redirectUri: start.redirectUri, verifier: start.verifier, resource: opts.resource === null ? undefined : (opts.resource ?? MCP_URL) });
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, tokens, clientId: start.client.client_id, redirectUri: start.redirectUri, verifier: start.verifier, label, code };
}

// ---------------------------------------------------------------------------------------------------------------------
// Owner console
// ---------------------------------------------------------------------------------------------------------------------
export interface OwnerSession { res: Response; cookie: string }
function setCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}
/** POST /owner/login; `cookie` is the `homcp_owner=...` pair to send back (empty string when login failed). */
export async function ownerLogin(passphrase: string = TEST_PASSPHRASE): Promise<OwnerSession> {
  const res = await SELF.fetch(`${BASE}/owner/login`, {
    method: "POST",
    redirect: "manual",
    headers: sameOriginHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({ passphrase }).toString()
  });
  const re = new RegExp(`^${OWNER_COOKIE}=([^;]+)`);
  const hit = setCookies(res).map((c) => re.exec(c.trim())).find((m) => m && m[1]);
  return { res, cookie: hit ? `${OWNER_COOKIE}=${hit[1]}` : "" };
}
/** Same-origin form POST to an /owner route with the session cookie. Pass `headers` to override/remove origin headers. */
export function ownerPost(path: string, form: Record<string, string>, cookie: string, headers?: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...sameOriginHeaders("application/x-www-form-urlencoded"), ...(cookie ? { cookie } : {}), ...(headers ?? {}) },
    body: new URLSearchParams(form).toString()
  });
}
export function ownerGet(path: string, cookie: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

// ---------------------------------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------------------------------
/** Plain GET through the Worker (landing, /health, /api/info, well-known, ...). */
export function get(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { redirect: "manual", ...init });
}
export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { throw new Error(`non-JSON body (${res.status}): ${text.slice(0, 300)}`); }
}
