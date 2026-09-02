// test/consent.test.ts [A] — §18 "consent" row: DCR → the approval page → passphrase checks, rate limit, state re-validation
// through the provider, deny/approve redirects, the token exchange, refresh rotation and per-label principals.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BASE, CONSENT_FIELDS, MCP_URL, TEST_PASSPHRASE, callTool, exchangeCode, oauthDance, refreshTokens, registerClient,
  startConsent, structuredOf, submitConsent
} from "./helpers";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

function principalOf(result: Parameters<typeof structuredOf>[0]): { via?: string; clientKey?: string; clientName?: string } {
  const s = structuredOf<Record<string, unknown>>(result);
  return (s.principal && typeof s.principal === "object" ? s.principal : s) as { via?: string; clientKey?: string; clientName?: string };
}
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
}
function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("GET /authorize", () => {
  it("dynamic client registration answers 201 with a client_id", async () => {
    const client = await registerClient({ clientName: "Claude Code", redirectUri: "http://localhost:3118/callback" });
    expect(client.client_id).toBeTruthy();
    expect(client.token_endpoint_auth_method).toBe("none");
  });

  it("renders the consent page with the exact CSP (no form-action), no-store, and the default label from the client name", async () => {
    const start = await startConsent({ clientName: "Claude Code", port: 3118 });
    expect(start.page.status).toBe(200);
    expect(start.page.headers.get("content-security-policy")).toBe(CSP);
    expect(start.page.headers.get("content-type")).toContain("text/html");
    expect(start.page.headers.get("cache-control")).toBe("no-store");
    expect(start.page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(start.page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(start.html).toContain("Claude Code");
    expect(start.html).toContain("homcp-test");
    expect(start.html).toMatch(/<input[^>]*name="label"[^>]*value="claude-code"/);
    expect(start.html).toMatch(/<input[^>]*name="passphrase"[^>]*type="password"/);
    expect(start.html).toMatch(/name="action"[^>]*value="approve"/);
    expect(start.html).toMatch(/name="action"[^>]*value="deny"/);
    expect(start.formState.length).toBeGreaterThan(20);
    expect(start.html).not.toContain(TEST_PASSPHRASE);
  });

  it("plain PKCE → 400 rendered locally (no redirect)", async () => {
    const start = await startConsent({ challengeMethod: "plain", port: 3119 });
    expect(start.page.status).toBe(400);
    expect(start.page.headers.get("location")).toBeNull();
  });

  it("a request with a redirect_uri the client never registered → 400", async () => {
    const client = await registerClient({ clientName: "Claude Code", redirectUri: "http://localhost:3120/callback" });
    const u = new URL(`${BASE}/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", client.client_id);
    u.searchParams.set("redirect_uri", "http://localhost:3120/somewhere-else");
    u.searchParams.set("code_challenge", "a".repeat(43));
    u.searchParams.set("code_challenge_method", "S256");
    const page = await SELF.fetch(u.toString(), { redirect: "manual" });
    expect(page.status).toBe(400);
    expect(page.headers.get("location")).toBeNull();
  });
});

describe("POST /authorize", () => {
  it("wrong passphrase → 403, and the 11th failure from the same address → 429", async () => {
    const start = await startConsent({ port: 3121 });
    const headers = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 10; i++) {
      const res = await submitConsent(start.formState, { passphrase: "wrong-passphrase", headers });
      expect(res.status).toBe(403);
    }
    const limited = await submitConsent(start.formState, { passphrase: "wrong-passphrase", headers });
    expect(limited.status).toBe(429);
    // even the right passphrase is refused while limited
    const stillLimited = await submitConsent(start.formState, { headers });
    expect(stillLimited.status).toBe(429);
    // another address is unaffected
    const other = await submitConsent(start.formState, { passphrase: "wrong-passphrase", headers: { "cf-connecting-ip": "203.0.113.8" } });
    expect(other.status).toBe(403);
  });

  it("a tampered redirect_uri inside the form state → 400 (re-parsed through the provider)", async () => {
    const start = await startConsent({ port: 3122 });
    const stored = JSON.parse(b64urlDecode(start.formState)) as Record<string, unknown>;
    expect(stored.redirectUri).toBe(start.redirectUri);
    stored.redirectUri = "http://localhost:3122/evil";
    const res = await submitConsent(b64urlEncode(JSON.stringify(stored)));
    expect(res.status).toBe(400);
  });

  it("corrupt state → 400", async () => {
    const res = await submitConsent("not-base64-json");
    expect(res.status).toBe(400);
  });

  it("deny → 302 to the client with error=access_denied, the client's state and iss", async () => {
    const start = await startConsent({ port: 3123, state: "client-state-123" });
    const res = await submitConsent(start.formState, { action: "deny" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(`${loc.protocol}//${loc.host}${loc.pathname}`).toBe(start.redirectUri);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state-123");
    expect(loc.searchParams.get("iss")).toBe(BASE);
    expect(loc.searchParams.get("code")).toBeNull();
  });

  it("an invalid label → 400", async () => {
    const start = await startConsent({ port: 3124 });
    const res = await submitConsent(start.formState, { label: "Not A Label!" });
    expect(res.status).toBe(400);
  });

  it("approve → 302 with code + state + iss; the token works and whoami reports via oauth with the label", async () => {
    const start = await startConsent({ port: 3125, state: "xyz" });
    const approved = await submitConsent(start.formState, { label: "claude-code" });
    expect(approved.status).toBe(302);
    const loc = new URL(approved.headers.get("location") ?? "");
    expect(`${loc.protocol}//${loc.host}${loc.pathname}`).toBe(start.redirectUri);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("xyz");
    expect(loc.searchParams.get("iss")).toBe(BASE);
    const tokens = await exchangeCode({ code: loc.searchParams.get("code")!, clientId: start.client.client_id, redirectUri: start.redirectUri, verifier: start.verifier, resource: MCP_URL });
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    const who = await callTool("whoami", {}, tokens.access_token);
    expect(who.isError).toBeFalsy();
    const p = principalOf(who);
    expect(p.via).toBe("oauth");
    expect(p.clientKey).toBe("claude-code");
  });

  it("refresh rotates the refresh token and the new access token works", async () => {
    const dance = await oauthDance({ port: 3126 });
    expect(dance.refreshToken).toBeTruthy();
    const refreshed = await refreshTokens(dance.refreshToken!, dance.clientId, MCP_URL);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(dance.accessToken);
    expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(dance.refreshToken);
    const who = await callTool("whoami", {}, refreshed.access_token);
    expect(principalOf(who).via).toBe("oauth");
  });

  it("a second dance with label `claude` yields a second principal", async () => {
    const first = await oauthDance({ port: 3127, label: "claude-code" });
    const second = await oauthDance({ port: 3128, label: "claude", clientName: "Claude" });
    expect(principalOf(await callTool("whoami", {}, first.accessToken)).clientKey).toBe("claude-code");
    expect(principalOf(await callTool("whoami", {}, second.accessToken)).clientKey).toBe("claude");
  });

  it("the consent form field names match the helper contract", () => {
    expect(CONSENT_FIELDS).toEqual({ state: "state", label: "label", passphrase: "passphrase", action: "action" });
  });
});
