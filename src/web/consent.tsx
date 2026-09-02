// src/web/consent.tsx [A] — the OAuth approval page (§13). GET renders "Connect <client> to <identity>" with a label and the
// owner passphrase; POST verifies the passphrase (rate-limited, constant time), re-parses the authorization request
// THROUGH the provider (so a tampered redirect_uri is rejected by the same code that validated the original), then
// completes or denies the grant. Props written here become the MCP principal (src/mcp/principal.ts).
import type { Context } from "hono";
import { AuthorizationError, CimdFetchError, type AuthRequest, type ClientInfo } from "@cloudflare/workers-oauth-provider";
import { CLIENT_KEY_RE, labelFromClientName } from "../mcp/principal";
import { loadIdentitySettings, resolveIdentity } from "../identity";
import { clientIp, constantTimeEqual, rateLimit } from "./session";
import type { Env, Identity } from "../types";

type Ctx = Context<{ Bindings: Env }>;

/** Exact CSP for the consent page: no scripts, no framing, inline styles only. Deliberately NO form-action (§13). */
export const CONSENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
export const CONSENT_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": CONSENT_CSP,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};
export const AUTHORIZE_RATE_LIMIT = { max: 10, ttl: 600 } as const;

// ---- state round trip: the parsed AuthRequest travels through the form as base64url(JSON) and is re-validated on POST ----
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
export function encodeState(req: AuthRequest): string { return b64urlEncode(JSON.stringify(req)); }

/** Rebuilds /authorize?… from the stored request so the provider re-validates every field (client, redirect_uri, PKCE, resource). */
export function rebuildAuthorizeUrl(origin: string, stored: Partial<AuthRequest>): string {
  const u = new URL("/authorize", origin);
  const set = (k: string, v: unknown) => { if (typeof v === "string" && v.length > 0) u.searchParams.set(k, v); };
  set("response_type", stored.responseType);
  set("client_id", stored.clientId);
  set("redirect_uri", stored.redirectUri);
  if (Array.isArray(stored.scope) && stored.scope.length > 0) u.searchParams.set("scope", stored.scope.filter((s) => typeof s === "string").join(" "));
  set("state", stored.state);
  set("code_challenge", stored.codeChallenge);
  set("code_challenge_method", stored.codeChallengeMethod);
  const resource = stored.resource;
  for (const r of Array.isArray(resource) ? resource : resource ? [resource] : []) if (typeof r === "string") u.searchParams.append("resource", r);
  return u.toString();
}

/** S256 with a 43-char challenge is the only PKCE we accept; anything else is a 400 rendered locally (never a redirect). */
function pkceProblem(challenge: string | null | undefined, method: string | null | undefined): string | null {
  if (method !== "S256") return "PKCE code_challenge_method must be S256.";
  if (!challenge || challenge.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(challenge)) return "PKCE code_challenge must be a 43-character base64url SHA-256 digest.";
  return null;
}

// ---- responses ----
function Page(props: { title: string; children?: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{props.title}</title>
        <style>{`
:root { color-scheme: light dark; --fg:#1a1a1a; --muted:#5b6270; --bg:#fafafa; --card:#fff; --line:#e2e5ea; --accent:#b45309; --danger:#b91c1c; }
@media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --muted:#a0a7b4; --bg:#121417; --card:#1b1e23; --line:#2c313a; --accent:#f59e0b; --danger:#f87171; } }
* { box-sizing:border-box } body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif }
.wrap { max-width:520px; margin:0 auto; padding:40px 20px } .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px }
h1 { font-size:22px; margin:0 0 8px } p { margin:8px 0; color:var(--muted) } code { background:rgba(127,127,127,.15); padding:1px 5px; border-radius:4px }
label { display:block; margin:14px 0 4px; font-weight:600 } input { width:100%; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit }
.row { display:flex; gap:10px; margin-top:18px } button { padding:10px 18px; border-radius:8px; border:1px solid var(--line); font:inherit; cursor:pointer; background:var(--card); color:var(--fg) }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff } .hint { font-size:13px } .err { color:var(--danger) }
dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:12px 0 } dt { color:var(--muted) } dd { margin:0; word-break:break-all }
        `}</style>
      </head>
      <body><div class="wrap"><div class="card">{props.children}</div></div></body>
    </html>
  );
}
function message(status: number, title: string, detail: string, extra: Record<string, string> = {}): Response {
  const html = `<!doctype html>\n${String(<Page title={title}><h1>{title}</h1><p class={status >= 400 ? "err" : ""}>{detail}</p></Page>)}`;
  return new Response(html, { status, headers: { ...CONSENT_HEADERS, ...extra } });
}
/** Maps provider errors: AuthorizationError with a validated redirect → 302 error redirect (RFC 9207 `iss`), otherwise 400; CIMD fetch failure → 502. */
function providerError(e: unknown, origin: string): Response {
  if (e instanceof AuthorizationError) {
    if (e.redirectUri) {
      const u = new URL(e.redirectUri);
      u.searchParams.set("error", e.code);
      u.searchParams.set("error_description", e.description);
      if (e.state) u.searchParams.set("state", e.state);
      u.searchParams.set("iss", e.issuer ?? origin);
      return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
    }
    return message(400, "Invalid authorization request", e.description);
  }
  if (e instanceof CimdFetchError) {
    return message(502, "Could not fetch client metadata", `The client's metadata document (${e.metadataUrl}) could not be fetched or validated; retry in a moment.`);
  }
  console.error("authorize", String(e));
  return message(500, "Authorization failed", "Unexpected error while validating the authorization request.");
}
async function logConsent(db: D1Database, action: "consent.approve" | "consent.deny", target: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await db.prepare("INSERT INTO registry_events(actor, action, target, detail) VALUES (?1, ?2, ?3, ?4)").bind("consent", action, target, JSON.stringify(detail)).run();
  } catch (e) {
    if (!/no such table/i.test(String(e))) console.warn("consent event", String(e));   // db_not_migrated is not a reason to block consent
  }
}
function redirectHostOf(uri: string): string { try { return new URL(uri).host; } catch { return uri; } }

// ---- the form ----
function ConsentForm(props: { client: ClientInfo; auth: AuthRequest; identity: Identity; state: string; defaultLabel: string }) {
  const clientName = props.client.clientName || props.client.clientId;
  return (
    <Page title={`Connect ${clientName} to ${props.identity.name}`}>
      <h1>Connect <b data-testid="client-name">{clientName}</b> to <b data-testid="identity-name">{props.identity.name}</b></h1>
      <p>{clientName} wants an OAuth grant for this MCP server. Approve with the owner passphrase; you can revoke the grant later in the owner console.</p>
      <dl>
        <dt>Client</dt><dd><code>{props.client.clientId}</code></dd>
        <dt>Returns to</dt><dd><code data-testid="redirect-host">{redirectHostOf(props.auth.redirectUri)}</code></dd>
        <dt>Scopes</dt><dd data-testid="scopes">{props.auth.scope.length ? props.auth.scope.join(" ") : "(none requested)"}</dd>
      </dl>
      <form method="post" action="/authorize">
        <input type="hidden" name="state" value={props.state} />
        <label for="label">Label for this connection</label>
        <input id="label" name="label" value={props.defaultLabel} pattern="^[a-z0-9][a-z0-9-]{0,31}$" maxlength={32} autocomplete="off" spellcheck={false} />
        <p class="hint">Lowercase letters, digits and dashes. Per-connection tool overrides are stored under this label; <code>whoami</code> reports it.</p>
        <label for="passphrase">Owner passphrase</label>
        <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus />
        <div class="row">
          <button class="primary" type="submit" name="action" value="approve">Approve</button>
          <button type="submit" name="action" value="deny">Deny</button>
        </div>
      </form>
    </Page>
  );
}

// ---- GET /authorize ----
export async function consentGet(c: Ctx): Promise<Response> {
  const env = c.env;
  const url = new URL(c.req.url);
  const origin = url.origin;
  // PKCE guard on the raw query BEFORE the provider sees it: a plain challenge must be a local 400, never an error redirect.
  const pkce = pkceProblem(url.searchParams.get("code_challenge"), url.searchParams.get("code_challenge_method"));
  if (pkce) return message(400, "Invalid authorization request", pkce);
  let auth: AuthRequest;
  let client: ClientInfo | null;
  try {
    auth = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
  } catch (e) { return providerError(e, origin); }
  if (!client) return message(400, "Invalid authorization request", "Unknown client_id.");
  const identity = resolveIdentity(await loadIdentitySettings(env.DB), env, url.host);
  const html = `<!doctype html>\n${String(<ConsentForm client={client} auth={auth} identity={identity} state={encodeState(auth)} defaultLabel={labelFromClientName(client.clientName)} />)}`;
  return new Response(html, { status: 200, headers: CONSENT_HEADERS });
}

// ---- POST /authorize ----
export async function consentPost(c: Ctx): Promise<Response> {
  const env = c.env;
  const url = new URL(c.req.url);
  const origin = url.origin;
  const limiter = await rateLimit(env.OAUTH_KV, `ratelimit:authorize:${clientIp(c.req.raw)}`, AUTHORIZE_RATE_LIMIT.max, AUTHORIZE_RATE_LIMIT.ttl);
  if (limiter.limited) return message(429, "Too many attempts", `More than ${AUTHORIZE_RATE_LIMIT.max} failed attempts in ${AUTHORIZE_RATE_LIMIT.ttl / 60} minutes. Try again later.`, { "retry-after": String(AUTHORIZE_RATE_LIMIT.ttl) });
  if (!env.OWNER_PASSPHRASE) return message(503, "Owner passphrase not configured", "Set the OWNER_PASSPHRASE secret (wrangler secret put OWNER_PASSPHRASE) and retry.");

  const form = await c.req.formData();
  const field = (k: string) => { const v = form.get(k); return typeof v === "string" ? v : ""; };
  const passphrase = field("passphrase");
  if (!passphrase || !(await constantTimeEqual(passphrase, env.OWNER_PASSPHRASE))) {
    await limiter.fail();
    return message(403, "Wrong passphrase", "The owner passphrase did not match. Go back and try again.");
  }

  let stored: Partial<AuthRequest>;
  try { stored = JSON.parse(b64urlDecode(field("state"))) as Partial<AuthRequest>; if (!stored || typeof stored !== "object") throw new Error("not an object"); }
  catch { return message(400, "Invalid authorization request", "The form state is missing or corrupt. Start the connection again from your client."); }

  let auth: AuthRequest;
  let client: ClientInfo | null;
  try {
    auth = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(rebuildAuthorizeUrl(origin, stored)));   // re-validated by the provider, never trusted from the form
    client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId);
  } catch (e) { return providerError(e, origin); }
  if (!client) return message(400, "Invalid authorization request", "Unknown client_id.");
  const pkce = pkceProblem(auth.codeChallenge, auth.codeChallengeMethod);
  if (pkce) return message(400, "Invalid authorization request", pkce);
  const clientName = client.clientName || client.clientId;
  const iss = auth.issuer ?? origin;

  if (field("action") === "deny") {
    const u = new URL(auth.redirectUri);
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", "The owner denied the request.");
    if (auth.state) u.searchParams.set("state", auth.state);
    u.searchParams.set("iss", iss);
    await logConsent(env.DB, "consent.deny", auth.clientId, { clientName, redirectUri: auth.redirectUri });
    return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
  }

  const label = field("label").trim() || labelFromClientName(client.clientName);
  if (!CLIENT_KEY_RE.test(label)) return message(400, "Invalid label", "Use 1–32 lowercase letters, digits or dashes, starting with a letter or digit.");
  const grantedAt = new Date().toISOString();
  let redirectTo: string;
  try {
    ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: auth,
      userId: "owner",
      metadata: { label, clientName, clientId: auth.clientId, redirectUri: auth.redirectUri, createdAt: grantedAt },
      scope: auth.scope,
      props: { userId: "owner", via: "oauth", clientKey: label, clientId: auth.clientId, clientName, scopes: auth.scope, grantedAt }
    }));
  } catch (e) { return providerError(e, origin); }
  await logConsent(env.DB, "consent.approve", label, { clientName, clientId: auth.clientId, redirectUri: auth.redirectUri, scopes: auth.scope });
  return new Response(null, { status: 302, headers: { location: redirectTo, "cache-control": "no-store" } });
}
