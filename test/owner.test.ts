// test/owner.test.ts [E] — §18 owner row: login cookie; wrong passphrase 403; POST without Origin/Sec-Fetch-Site → 403;
// toggle via form changes tools/list; grants list after a dance; revoke → bearer 401s; export redacts. Plus identity + logout.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, TEST_IDENTITY, TEST_PASSPHRASE, get, json, legacyInit, mcp, oauthDance, ownerGet, ownerLogin, ownerPost, readJsonRpc, rpc, toolNames } from "./helpers";

const COOKIE_RE = /homcp_owner=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/owner; Max-Age=43200/;

describe("owner console — login", () => {
  it("GET /owner without a session is the login page (not a 501)", async () => {
    const res = await get("/owner");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="login-form"');
    expect(html).toContain(TEST_IDENTITY);
    expect(html).not.toContain('data-testid="tools-table"');
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("right passphrase sets the HMAC cookie and the console renders", async () => {
    const { res, cookie } = await ownerLogin();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/owner");
    expect(cookie).toMatch(/^homcp_owner=\d+\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(COOKIE_RE);
    const page = await ownerGet("/owner", cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-testid="tools-table"');
    expect(html).toContain('data-testid="identity-form"');
    expect(html).toContain('data-tool="remember"');
    expect(html).toContain('data-tool="list_tools"');
    expect(html).not.toContain(TEST_PASSPHRASE);
  });

  it("wrong passphrase → 403 and no cookie", async () => {
    const { res, cookie } = await ownerLogin("nope");
    expect(res.status).toBe(403);
    expect(cookie).toBe("");
    expect(await res.text()).toContain('data-testid="login-error"');
  });

  it("login without Origin / Sec-Fetch-Site → 403", async () => {
    const res = await fetchRaw("/owner/login", { passphrase: TEST_PASSPHRASE }, {});
    expect(res.status).toBe(403);
  });

  it("ten failures rate-limit the eleventh attempt with 429 (per client address)", async () => {
    // Own address so this counter never touches the other tests' logins (KV writes made by the Worker are not undone per test).
    const ip = { "cf-connecting-ip": "203.0.113.77" };
    for (let i = 0; i < 10; i++) expect((await fetchRaw("/owner/login", { passphrase: "wrong" }, { ...sameOrigin, ...ip })).status).toBe(403);
    const limited = await fetchRaw("/owner/login", { passphrase: TEST_PASSPHRASE }, { ...sameOrigin, ...ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    // a different address is unaffected
    expect((await ownerLogin()).res.status).toBe(303);
  });

  it("a forged cookie is rejected", async () => {
    const forged = `homcp_owner=${Date.now()}.${crypto.randomUUID()}.AAAA`;
    expect((await ownerGet("/owner/export", forged)).status).toBe(403);
    const html = await (await ownerGet("/owner", forged)).text();
    expect(html).toContain('data-testid="login-form"');
  });

  it("logout clears the cookie and revokes the KV session", async () => {
    const { cookie } = await ownerLogin();
    const out = await ownerPost("/owner/logout", {}, cookie);
    expect(out.status).toBe(303);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await ownerGet("/owner/export", cookie)).status).toBe(403);
  });
});

describe("owner console — same-origin and session guards", () => {
  it("POST /owner/tools/remember without Origin/Sec-Fetch-Site → 403 even with a cookie", async () => {
    const { cookie } = await ownerLogin();
    const res = await fetchRaw("/owner/tools/remember", { action: "disable" }, { cookie });
    expect(res.status).toBe(403);
    expect(await toolNames()).toContain("remember");
  });
  it("POST without a cookie → 403", async () => {
    const res = await ownerPost("/owner/tools/remember", { action: "disable" }, "");
    expect(res.status).toBe(403);
    expect(await toolNames()).toContain("remember");
  });
  it("GET /owner/export without a cookie → 403", async () => {
    expect((await get("/owner/export")).status).toBe(403);
  });
});

describe("owner console — tools", () => {
  it("disable / enable via the form changes tools/list for MCP clients", async () => {
    const { cookie } = await ownerLogin();
    expect(await toolNames()).toContain("remember");
    const off = await ownerPost("/owner/tools/remember", { action: "disable" }, cookie);
    expect(off.status).toBe(303);
    expect(off.headers.get("location")).toContain("/owner?msg=");
    expect(await toolNames()).not.toContain("remember");
    const location = (off.headers.get("location") ?? "/owner").replace(/#.*$/, "");
    const page = await (await ownerGet(location, cookie)).text();
    expect(page).toContain('data-testid="flash-msg"');
    expect(page).toContain("Disabled remember");
    const on = await ownerPost("/owner/tools/remember", { action: "enable" }, cookie);
    expect(on.status).toBe(303);
    expect(await toolNames()).toContain("remember");
  });

  it("promote / demote a hidden built-in", async () => {
    const { cookie } = await ownerLogin();
    expect(await toolNames()).not.toContain("set_identity");
    expect((await ownerPost("/owner/tools/set_identity", { action: "promote" }, cookie)).status).toBe(303);
    expect(await toolNames()).toContain("set_identity");
    expect((await ownerPost("/owner/tools/set_identity", { action: "demote" }, cookie)).status).toBe(303);
    expect(await toolNames()).not.toContain("set_identity");
  });

  it("protected, unknown, built-in remove and bad actions are refused", async () => {
    const { cookie } = await ownerLogin();
    expect((await ownerPost("/owner/tools/list_tools", { action: "disable" }, cookie)).status).toBe(400);
    expect((await ownerPost("/owner/tools/no_such_tool", { action: "disable" }, cookie)).status).toBe(404);
    expect((await ownerPost("/owner/tools/remember", { action: "remove" }, cookie)).status).toBe(400);
    expect((await ownerPost("/owner/tools/remember", { action: "explode" }, cookie)).status).toBe(400);
    expect(await toolNames()).toContain("list_tools");
  });

  it("the log shows the owner-console actor after a mutation", async () => {
    const { cookie } = await ownerLogin();
    await ownerPost("/owner/tools/recall", { action: "disable" }, cookie);
    const html = await (await ownerGet("/owner", cookie)).text();
    expect(html).toContain('data-testid="events-table"');
    expect(html).toContain("owner-console");
    expect((await ownerPost("/owner/tools/recall", { action: "enable" }, cookie)).status).toBe(303);
  });
});

describe("owner console — identity", () => {
  it("renames the instance without a redeploy; serverInfo and the landing follow", async () => {
    const { cookie } = await ownerLogin();
    const res = await ownerPost("/owner/identity", { name: "renamed-1", title: "Renamed", description: "desc", instructions: "" }, cookie);
    expect(res.status).toBe(303);
    const init = await readJsonRpc<{ serverInfo: { name: string; title?: string } }>(await mcp(legacyInit()));
    expect(init.result?.serverInfo.name).toBe("renamed-1");
    const landing = await (await get("/")).text();
    expect(landing).toContain(`claude mcp add --transport http --scope user renamed-1 ${BASE}/mcp`);
    const health = await json<{ name: string }>(await get("/health"));
    expect(health.name).toBe("renamed-1");
    expect((await ownerPost("/owner/identity", { reset: "1" }, cookie)).status).toBe(303);
    expect((await json<{ name: string }>(await get("/health"))).name).toBe(TEST_IDENTITY);
  });
  it("rejects invalid names and over-long fields", async () => {
    const { cookie } = await ownerLogin();
    expect((await ownerPost("/owner/identity", { name: "Bad Name" }, cookie)).status).toBe(400);
    expect((await ownerPost("/owner/identity", { name: "a.b" }, cookie)).status).toBe(400);
    expect((await ownerPost("/owner/identity", { name: "ok", title: "x".repeat(81) }, cookie)).status).toBe(400);
    expect((await json<{ name: string }>(await get("/health"))).name).toBe(TEST_IDENTITY);
  });
});

describe("owner console — connections", () => {
  it("lists the grant of an OAuth dance and revoking it 401s the bearer", async () => {
    const dance = await oauthDance({ label: "claude-code" });
    const ok = await mcp(rpc("tools/list"), { token: dance.accessToken });
    expect(ok.status).toBe(200);
    const { cookie } = await ownerLogin();
    const html = await (await ownerGet("/owner", cookie)).text();
    expect(html).toContain('data-testid="grants-table"');
    expect(html).toContain('data-label="claude-code"');
    const m = /data-grant="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    const grantId = m![1]!;
    const revoke = await ownerPost(`/owner/grants/${encodeURIComponent(grantId)}/revoke`, {}, cookie);
    expect(revoke.status).toBe(303);
    const gone = await mcp(rpc("tools/list"), { token: dance.accessToken });
    expect(gone.status).toBe(401);
    const after = await (await ownerGet("/owner", cookie)).text();
    expect(after).not.toContain(`data-grant="${grantId}"`);
  });
});

describe("owner console — export", () => {
  it("is a redacted JSON attachment", async () => {
    await env.DB.prepare("INSERT INTO upstreams (name, url, auth_kind, auth_value, headers, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind("up1", "https://upstream.example/mcp", "bearer", "topsecret-value", JSON.stringify({ authorization: "Bearer hdr-secret", "x-plain": "keep" }), "test").run();
    const { cookie } = await ownerLogin();
    const res = await ownerGet("/owner/export", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = await res.text();
    expect(text).not.toContain("topsecret-value");
    expect(text).not.toContain("hdr-secret");
    expect(text).not.toContain(TEST_PASSPHRASE);
    const body = JSON.parse(text) as { identity: { name: string }; upstreams: Array<{ name: string; auth_kind: string; headers: Record<string, string> }>; tools: unknown[]; schema: string };
    expect(body.identity.name).toBe(TEST_IDENTITY);
    expect(body.schema).toBe("ok");
    expect(body.upstreams[0]).toMatchObject({ name: "up1", auth_kind: "bearer", headers: { authorization: "•••", "x-plain": "keep" } });
    expect(body.upstreams[0]).not.toHaveProperty("auth_value");
    expect(body.upstreams[0]).not.toHaveProperty("tool_cache");
    const page = await (await ownerGet("/owner", cookie)).text();
    expect(page).toContain('data-upstream="up1"');
    expect(page).not.toContain("topsecret-value");
  });
});

// ---- raw POST with caller-controlled headers -------------------------------------------------------------------------
import { SELF } from "cloudflare:test";
const sameOrigin = { origin: BASE, "sec-fetch-site": "same-origin" };
function fetchRaw(path: string, form: Record<string, string>, headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString()
  });
}
