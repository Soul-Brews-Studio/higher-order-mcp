// src/web/owner.tsx [E] — the owner console (§13): passphrase login, HMAC cookie + KV session (src/web/session.ts),
// same-origin POSTs, deploy-layer tool switches, upstream removal, grant revocation, audit log and a redacted export.
//
// Mounting (src/web/app.tsx): routes here carry their FULL paths (/owner, /owner/login, ...), so mount with
//   import { ownerRoutes } from "./owner";  webApp.route("/", ownerRoutes);
// Every mutation goes through registry/db.ts with actor "owner-console" and ends with notifyToolsChanged().
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { clientIp, clearOwnerCookie, constantTimeEqual, isSameOrigin, mintOwnerSession, rateLimit, revokeOwnerSession, verifyOwnerSession } from "./session";
import { resolveIdentity, validateIdentityName } from "../identity";
import { notifyToolsChanged } from "../mcp/handler";
import { BUILTINS } from "../tools/builtin";
import { deleteDef, deleteUpstream, emptySnapshot, isSchemaMissing, listEvents, loadSnapshot, setSettings, upsertOverride, type RegistryEvent } from "../registry/db";
import { resolveCatalog } from "../registry/resolve";
import { nameBudget } from "../registry/names";
import { VERSION } from "../version";
import { SchemaMissingError, type Env, type Principal, type ResolvedCatalog, type ResolvedTool, type Snapshot } from "../types";
import { Layout, PAGE_HEADERS, htmlResponse, renderDocument } from "./layout";
import { ThreeNames } from "./landing";
import { WEB_CLIENT_KEY, installSnippets } from "./snippets";

type App = { Bindings: Env };
type Ctx = Context<App>;

export const OWNER_ACTOR = "owner-console";
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_TTL = 600;

// ---------------------------------------------------------------------------------------------------------------------
// Catalog for web routes (the console and, if wanted, the public pages)
// ---------------------------------------------------------------------------------------------------------------------
/** One registry snapshot for a web request; a missing schema degrades to emptySnapshot() instead of failing the page. */
export async function loadWebSnapshot(env: Env, clientKey: string = WEB_CLIENT_KEY): Promise<Snapshot> {
  try {
    return await loadSnapshot(env.DB, clientKey);
  } catch (e) {
    if (e instanceof SchemaMissingError || isSchemaMissing(e)) return emptySnapshot();
    throw e;
  }
}

/** The resolved catalog as the web sees it (deploy layer; `clientKey` never has overrides of its own). */
export async function loadWebCatalog(env: Env, host: string, clientKey: string = WEB_CLIENT_KEY): Promise<ResolvedCatalog> {
  const snapshot = await loadWebSnapshot(env, clientKey);
  const identity = resolveIdentity(snapshot.settings, env, host);
  const principal: Principal = { userId: "owner", via: "oauth", clientKey, clientName: "owner console", scopes: [] };
  return resolveCatalog(BUILTINS, snapshot, principal, identity);
}

// ---------------------------------------------------------------------------------------------------------------------
// Guards and helpers
// ---------------------------------------------------------------------------------------------------------------------
function hostOf(c: Ctx): string {
  return new URL(c.req.url).host;
}
function originOf(c: Ctx): string {
  return new URL(c.req.url).origin;
}

/** Middleware: same-origin for non-GET (§13), then a valid owner session. 403 JSON otherwise. */
export const requireOwner: MiddlewareHandler<App> = async (c, next) => {
  if (c.req.method !== "GET" && !isSameOrigin(c.req.raw, originOf(c))) return c.json({ error: "forbidden", reason: "cross-origin request" }, 403);
  const session = await verifyOwnerSession(c.req.raw, c.env);
  if (!session) return c.json({ error: "forbidden", reason: "owner login required" }, 403);
  await next();
};

type FormBody = Record<string, string | File | (string | File)[]>;
async function form(c: Ctx): Promise<FormBody> {
  return (await c.req.parseBody()) as unknown as FormBody;
}
function field(body: FormBody, name: string): string {
  const v = body[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) { const first = v.find((x) => typeof x === "string"); return typeof first === "string" ? first : ""; }
  return "";
}
function flag(body: FormBody, name: string): boolean {
  const v = field(body, name).toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}
function backTo(c: Ctx, params: { msg?: string; err?: string }, anchor = ""): Response {
  const u = new URL("/owner", originOf(c));
  if (params.msg) u.searchParams.set("msg", params.msg);
  if (params.err) u.searchParams.set("err", params.err);
  return c.redirect(`${u.pathname}${u.search}${anchor}`, 303);
}
function errorPage(c: Ctx, status: number, message: string): Response {
  const page = (
    <Layout title="Owner console — error">
      <h1>Owner console</h1>
      <div class="box error" data-testid="owner-error"><b>{String(status)}</b> — {message}</div>
      <p><a href="/owner">← Back to the console</a></p>
    </Layout>
  );
  return htmlResponse(renderDocument(page), status);
}
const NOT_MIGRATED = "The database is not migrated; run `npm run db:migrate:remote` first.";

const SENSITIVE_KEY = /authorization|token|secret|passw|api[-_]?key|cookie/i;
/** Redacts secrets in a JSON-ish value: `{{secret:X}}` placeholders stay, bearer values and sensitive keys become •••. */
export function redactValue(v: unknown, key?: string): unknown {
  if (typeof v === "string") {
    if (v.includes("{{secret:")) return v;
    if (key && SENSITIVE_KEY.test(key)) return "•••";
    return v.replace(/(bearer\s+)\S+/gi, "$1•••");
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactValue(x, k)]));
  return v;
}
function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
function upstreamOf(spec: string): string | null {
  const parsed = parseJson(spec);
  return parsed && typeof parsed === "object" && typeof (parsed as { upstream?: unknown }).upstream === "string" ? (parsed as { upstream: string }).upstream : null;
}
function fmtDate(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

export interface GrantView { id: string; clientId: string; clientName: string; label: string; scopes: string[]; createdAt: string; redirectUri: string }
async function listGrants(env: Env): Promise<GrantView[]> {
  const helpers = env.OAUTH_PROVIDER;
  if (!helpers || typeof helpers.listUserGrants !== "function") return [];
  try {
    const result = await helpers.listUserGrants("owner", { limit: 100 });
    return result.items.map((g) => {
      const meta = (g.metadata && typeof g.metadata === "object" ? g.metadata : {}) as Record<string, unknown>;
      return {
        id: g.id, clientId: g.clientId,
        clientName: typeof meta.clientName === "string" ? meta.clientName : "",
        label: typeof meta.label === "string" ? meta.label : "",
        scopes: g.scope ?? [],
        createdAt: fmtDate(typeof meta.createdAt === "string" ? meta.createdAt : g.createdAt),
        redirectUri: typeof meta.redirectUri === "string" ? meta.redirectUri : ""
      };
    });
  } catch (e) {
    console.warn("owner: listUserGrants failed", String(e));
    return [];
  }
}
async function loadEvents(env: Env): Promise<RegistryEvent[]> {
  try {
    return await listEvents(env.DB, 100);
  } catch (e) {
    if (e instanceof SchemaMissingError || isSchemaMissing(e)) return [];
    console.warn("owner: listEvents failed", String(e));
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------------
function LoginPage(props: { name: string; error?: string; noPassphrase?: boolean }) {
  return (
    <Layout title={`${props.name} — owner login`}>
      <h1>{props.name} <span class="muted">· owner console</span></h1>
      <p class="sub">The same passphrase you type on the OAuth approval page. Sessions last 12 hours.</p>
      {props.noPassphrase ? <div class="box warn"><b>OWNER_PASSPHRASE is not set.</b> Run <code>wrangler secret put OWNER_PASSPHRASE</code>, then reload.</div> : null}
      {props.error ? <div class="box error" data-testid="login-error">{props.error}</div> : null}
      <form class="stack" method="post" action="/owner/login" data-testid="login-form">
        <label for="passphrase">Owner passphrase</label>
        <input id="passphrase" type="password" name="passphrase" autocomplete="current-password" required />
        <p><button class="btn" type="submit">Sign in</button> <a class="btn secondary" href="/">Landing page</a></p>
      </form>
    </Layout>
  );
}

function ToolRow(props: { tool: ResolvedTool; budgetFull: boolean }) {
  const t = props.tool;
  const st = t.state;
  const act = (action: string, label: string, cls = "btn small secondary") => (
    <form method="post" action={`/owner/tools/${encodeURIComponent(t.name)}`}>
      <input type="hidden" name="action" value={action} />
      <button class={cls} type="submit">{label}</button>
    </form>
  );
  return (
    <tr data-testid="tool-row" data-tool={t.name}>
      <td><code>{t.name}</code>{t.protected ? <span class="muted"> (protected)</span> : null}</td>
      <td>{t.kind}</td>
      <td>{st.title}</td>
      <td>{st.enabled ? <span class="ok">on</span> : <span class="muted">off</span>} <span class="muted">· {st.decidedBy.enabled}</span></td>
      <td>{st.promoted ? <span class="ok">listed</span> : <span class="muted">hidden</span>} <span class="muted">· {st.decidedBy.promoted}</span></td>
      <td>
        {t.protected ? <span class="muted">always on</span> : (
          <div class="actions">
            {st.enabled ? act("disable", "Disable") : act("enable", "Enable")}
            {st.promoted ? act("demote", "Demote") : act("promote", props.budgetFull && t.kind !== "builtin" ? "Promote (budget full)" : "Promote")}
            {t.kind !== "builtin" ? act("remove", "Remove", "btn small danger") : null}
          </div>
        )}
      </td>
    </tr>
  );
}

interface ConsoleProps { catalog: ResolvedCatalog; snapshot: Snapshot; origin: string; grants: GrantView[]; events: RegistryEvent[]; msg?: string; err?: string }
function ConsolePage(p: ConsoleProps) {
  const { catalog, snapshot } = p;
  const id = catalog.identity;
  const tools = [...catalog.tools.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const budget = catalog.budget;
  const budgetFull = budget.usedDeploy >= budget.limit;
  const pct = budget.limit > 0 ? Math.min(100, Math.round((budget.usedDeploy / budget.limit) * 100)) : 0;
  const s = installSnippets(id, p.origin);
  const dependents = (name: string) => snapshot.defs.filter((d) => d.kind === "mcp" && upstreamOf(d.spec) === name).map((d) => d.name);
  return (
    <Layout title={`${id.name} — owner console`}>
      <h1>{id.name} <span class="muted">· owner console</span></h1>
      <p class="sub">v{VERSION} · catalog_version {catalog.catalogVersion} · <a href="/">landing page</a></p>
      <div class="actions">
        <form method="post" action="/owner/logout"><button class="btn small secondary" type="submit">Sign out</button></form>
        <a class="btn small secondary" href="/owner/export">Export (redacted JSON)</a>
      </div>
      {p.msg ? <div class="box" data-testid="flash-msg"><span class="ok">✓</span> {p.msg}</div> : null}
      {p.err ? <div class="box error" data-testid="flash-err">{p.err}</div> : null}
      {catalog.schemaMissing ? <div class="box warn" data-testid="schema-missing"><b>Database not migrated</b> — run <code>npm run db:migrate:remote</code>. Only built-in tools are available; the switches below cannot be saved until then.</div> : null}
      {catalog.warnings.length ? <div class="box warn">{catalog.warnings.map((w) => <p>{w}</p>)}</div> : null}
      <nav class="tabs">
        <a href="#identity">Identity</a><a href="#tools">Tools</a><a href="#upstreams">Upstreams</a><a href="#connections">Connections</a><a href="#log">Log</a><a href="#export">Export</a>
      </nav>

      <h2 id="identity">Identity</h2>
      <p class="note">Currently <code>{id.name}</code> (source: {id.source}). Tool-name budget for this name: {nameBudget(id.name)} characters. Renaming never touches tool names, data or tokens; clients keep the key they typed.</p>
      <form class="stack" method="post" action="/owner/identity" data-testid="identity-form">
        <label for="id-name">Name (letters, digits, - and _; max 32; empty = fall back to the var / hostname)</label>
        <input id="id-name" type="text" name="name" value={id.source === "settings" ? id.name : ""} placeholder={id.name} maxlength={32} />
        <label for="id-title">Title (optional, ≤ 80)</label>
        <input id="id-title" type="text" name="title" value={id.title ?? ""} maxlength={80} />
        <label for="id-description">Description (optional, ≤ 300)</label>
        <input id="id-description" type="text" name="description" value={id.description ?? ""} maxlength={300} />
        <label for="id-instructions">Instructions for the model (optional, ≤ 1000; empty = default)</label>
        <textarea id="id-instructions" name="instructions" maxlength={1000}>{snapshot.settings.identity_instructions ?? ""}</textarea>
        <p><button class="btn" type="submit">Save</button> <button class="btn secondary" type="submit" name="reset" value="1">Reset to defaults</button></p>
      </form>
      <details><summary>The three names</summary><ThreeNames name={id.name} /></details>
      <details><summary>Install snippets for this identity</summary><pre><code>{s.claudeAdd}{"\n"}{s.claudeLogin}</code></pre><pre><code>{s.claudeAiLink}</code></pre></details>

      <h2 id="tools">Tools <span class="muted">(deploy layer)</span></h2>
      <p class="note">Promoted definitions: {budget.usedDeploy} of {budget.limit}{budget.usedClient > 0 ? ` (+${budget.usedClient} promoted by individual connections)` : ""}. Disabling here hides a tool from every connection; connections cannot re-enable it.</p>
      <div class="bar" data-testid="budget-bar"><span style={`width:${pct}%`}></span></div>
      <table data-testid="tools-table">
        <thead><tr><th>Name</th><th>Kind</th><th>Title</th><th>Enabled</th><th>Listed</th><th>Actions</th></tr></thead>
        <tbody>{tools.map((t) => <ToolRow tool={t} budgetFull={budgetFull} />)}</tbody>
      </table>

      <h2 id="upstreams">Upstreams</h2>
      {catalog.upstreams.length === 0 ? <p class="note">None. Ask Claude to run <code>add_upstream</code> (hidden tool, reachable through <code>call_tool</code>).</p> : (
        <table data-testid="upstreams-table">
          <thead><tr><th>Name</th><th>URL</th><th>Auth</th><th>Cached</th><th>Used by</th><th></th></tr></thead>
          <tbody>
            {catalog.upstreams.map((u) => {
              const deps = dependents(u.name);
              return (
                <tr data-testid="upstream-row" data-upstream={u.name}>
                  <td><code>{u.name}</code></td><td><code>{u.url}</code></td><td>{u.auth_kind}</td><td>{u.cached_at ?? "never"}</td>
                  <td>{deps.length ? deps.map((d) => <code>{d} </code>) : <span class="muted">—</span>}</td>
                  <td>
                    <form method="post" action={`/owner/upstreams/${encodeURIComponent(u.name)}/delete`} class="actions">
                      {deps.length ? <label><input type="checkbox" name="force" value="1" /> also remove {deps.length} definition(s)</label> : null}
                      <button class="btn small danger" type="submit">Delete</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2 id="connections">Connections</h2>
      <p class="note">OAuth grants issued to MCP clients. Revoking one invalidates its access and refresh tokens; the client must sign in again.</p>
      {p.grants.length === 0 ? <p class="note" data-testid="no-grants">No grants yet.</p> : (
        <table data-testid="grants-table">
          <thead><tr><th>Label</th><th>Client</th><th>Client id</th><th>Scopes</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {p.grants.map((g) => (
              <tr data-testid="grant-row" data-grant={g.id} data-label={g.label}>
                <td><code>{g.label || "—"}</code></td><td>{g.clientName || "—"}</td><td class="muted"><code>{g.clientId}</code></td><td class="muted">{g.scopes.join(" ") || "—"}</td><td class="muted">{g.createdAt}</td>
                <td><form method="post" action={`/owner/grants/${encodeURIComponent(g.id)}/revoke`}><button class="btn small danger" type="submit">Revoke</button></form></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 id="log">Log <span class="muted">(last 100 registry events)</span></h2>
      {p.events.length === 0 ? <p class="note">No events yet.</p> : (
        <table data-testid="events-table">
          <thead><tr><th>At</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
          <tbody>{p.events.map((e) => <tr><td class="muted">{e.at}</td><td>{e.actor}</td><td>{e.action}</td><td><code>{e.target}</code></td><td class="muted">{detailText(e.detail)}</td></tr>)}</tbody>
        </table>
      )}

      <h2 id="export">Export</h2>
      <p class="note"><a href="/owner/export">Download a redacted JSON snapshot</a> of settings, definitions, overrides and upstreams (no tokens, no secrets, no cached upstream tool lists).</p>
    </Layout>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------------
export const ownerRoutes = new Hono<App>();

ownerRoutes.get("/owner", async (c) => {
  const host = hostOf(c);
  const snapshot = await loadWebSnapshot(c.env);
  const identity = resolveIdentity(snapshot.settings, c.env, host);
  const session = await verifyOwnerSession(c.req.raw, c.env);
  if (!session) return htmlResponse(renderDocument(<LoginPage name={identity.name} noPassphrase={!c.env.OWNER_PASSPHRASE} />));
  const principal: Principal = { userId: "owner", via: "oauth", clientKey: WEB_CLIENT_KEY, clientName: "owner console", scopes: [] };
  const catalog = resolveCatalog(BUILTINS, snapshot, principal, identity);
  const [grants, events] = await Promise.all([listGrants(c.env), loadEvents(c.env)]);
  const page = <ConsolePage catalog={catalog} snapshot={snapshot} origin={originOf(c)} grants={grants} events={events} msg={c.req.query("msg") ?? undefined} err={c.req.query("err") ?? undefined} />;
  return htmlResponse(renderDocument(page));
});

ownerRoutes.post("/owner/login", async (c) => {
  if (!isSameOrigin(c.req.raw, originOf(c))) return c.json({ error: "forbidden", reason: "cross-origin request" }, 403);
  const snapshot = await loadWebSnapshot(c.env);
  const name = resolveIdentity(snapshot.settings, c.env, hostOf(c)).name;
  if (!c.env.OWNER_PASSPHRASE) return htmlResponse(renderDocument(<LoginPage name={name} noPassphrase />), 503);
  const limiter = await rateLimit(c.env.OAUTH_KV, `ratelimit:owner-login:${clientIp(c.req.raw)}`, LOGIN_MAX_FAILURES, LOGIN_WINDOW_TTL);
  if (limiter.limited) {
    return htmlResponse(renderDocument(<LoginPage name={name} error="Too many failed attempts. Try again in ten minutes." />), 429, { "retry-after": String(LOGIN_WINDOW_TTL) });
  }
  const body = await form(c);
  const passphrase = field(body, "passphrase");
  if (!passphrase || !(await constantTimeEqual(passphrase, c.env.OWNER_PASSPHRASE))) {
    await limiter.fail();
    return htmlResponse(renderDocument(<LoginPage name={name} error="Wrong passphrase." />), 403);
  }
  const minted = await mintOwnerSession(c.env);
  if (!minted) return htmlResponse(renderDocument(<LoginPage name={name} noPassphrase />), 503);
  c.header("set-cookie", minted.setCookie);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) if (k !== "content-type") c.header(k, v);
  return c.redirect("/owner", 303);
});

ownerRoutes.post("/owner/logout", async (c) => {
  if (!isSameOrigin(c.req.raw, originOf(c))) return c.json({ error: "forbidden", reason: "cross-origin request" }, 403);
  c.header("set-cookie", await revokeOwnerSession(c.req.raw, c.env));
  return c.redirect("/owner", 303);
});

ownerRoutes.post("/owner/identity", requireOwner, async (c) => {
  const body = await form(c);
  const snapshot = await loadWebSnapshot(c.env);
  if (snapshot.schemaMissing) return errorPage(c, 503, NOT_MIGRATED);
  if (flag(body, "reset")) {
    await setSettings(c.env.DB, { identity_name: null, identity_title: null, identity_description: null, identity_instructions: null }, OWNER_ACTOR);
    notifyToolsChanged();
    return backTo(c, { msg: "Identity reset to defaults (var → hostname → homcp)." }, "#identity");
  }
  const name = field(body, "name").trim();
  const title = field(body, "title").trim();
  const description = field(body, "description").trim();
  const instructions = field(body, "instructions").trim();
  if (name) {
    const problem = validateIdentityName(name);
    if (problem) return errorPage(c, 400, problem);
  }
  if (title.length > 80) return errorPage(c, 400, "Title is longer than 80 characters.");
  if (description.length > 300) return errorPage(c, 400, "Description is longer than 300 characters.");
  if (instructions.length > 1000) return errorPage(c, 400, "Instructions are longer than 1000 characters.");
  await setSettings(c.env.DB, {
    identity_name: name || null, identity_title: title || null, identity_description: description || null, identity_instructions: instructions || null
  }, OWNER_ACTOR);
  notifyToolsChanged();
  const effective = name || resolveIdentity({ ...snapshot.settings, identity_name: "" }, c.env, hostOf(c)).name;
  const budget = nameBudget(effective);
  const offenders = snapshot.defs.filter((d) => d.name.length > budget).map((d) => d.name);
  const msg = `Identity saved: ${effective}. Tool-name budget is now ${budget}.` + (offenders.length ? ` Over budget (rename or remove): ${offenders.join(", ")}.` : "");
  return backTo(c, { msg }, "#identity");
});

ownerRoutes.post("/owner/tools/:name", requireOwner, async (c) => {
  const name = c.req.param("name");
  const body = await form(c);
  const action = field(body, "action");
  const catalog = await loadWebCatalog(c.env, hostOf(c));
  if (catalog.schemaMissing) return errorPage(c, 503, NOT_MIGRATED);
  const tool = catalog.tools.get(name);
  if (!tool) return errorPage(c, 404, `No tool named '${name}'.`);
  if (tool.protected) return errorPage(c, 400, `'${name}' is protected: it is always enabled and listed.`);
  const db = c.env.DB;
  let msg: string;
  switch (action) {
    case "enable":
      await upsertOverride(db, "deploy", "", name, { enabled: true }, OWNER_ACTOR);
      msg = `Enabled ${name} for every connection.`;
      break;
    case "disable":
      await upsertOverride(db, "deploy", "", name, { enabled: false }, OWNER_ACTOR);
      msg = `Disabled ${name} for every connection.`;
      break;
    case "promote":
      if (!tool.state.enabled) return errorPage(c, 409, `'${name}' is disabled; enable it first.`);
      if (tool.kind !== "builtin" && !tool.state.promoted && catalog.budget.usedDeploy >= catalog.budget.limit) {
        return errorPage(c, 409, `Promoted budget is full (${catalog.budget.usedDeploy}/${catalog.budget.limit}). Demote another definition first.`);
      }
      await upsertOverride(db, "deploy", "", name, { promoted: true }, OWNER_ACTOR);
      msg = `Promoted ${name}: it is now in tools/list.`;
      break;
    case "demote":
      await upsertOverride(db, "deploy", "", name, { promoted: false }, OWNER_ACTOR);
      msg = `Demoted ${name}: hidden from tools/list, still callable through call_tool.`;
      break;
    case "remove":
      if (tool.kind === "builtin") return errorPage(c, 400, `'${name}' is a built-in tool; disable it instead.`);
      await deleteDef(db, name, OWNER_ACTOR);
      msg = `Removed definition ${name} and its overrides.`;
      break;
    default:
      return errorPage(c, 400, `Unknown action '${action}'. Use enable, disable, promote, demote or remove.`);
  }
  notifyToolsChanged();
  return backTo(c, { msg }, "#tools");
});

ownerRoutes.post("/owner/upstreams/:name/delete", requireOwner, async (c) => {
  const name = c.req.param("name");
  const body = await form(c);
  const snapshot = await loadWebSnapshot(c.env);
  if (snapshot.schemaMissing) return errorPage(c, 503, NOT_MIGRATED);
  if (!snapshot.upstreams.some((u) => u.name === name)) return errorPage(c, 404, `No upstream named '${name}'.`);
  const dependents = snapshot.defs.filter((d) => d.kind === "mcp" && upstreamOf(d.spec) === name).map((d) => d.name);
  if (dependents.length && !flag(body, "force")) {
    return errorPage(c, 409, `Upstream '${name}' is used by ${dependents.join(", ")}. Tick "also remove" to delete them too.`);
  }
  for (const d of dependents) await deleteDef(c.env.DB, d, OWNER_ACTOR);
  await deleteUpstream(c.env.DB, name, OWNER_ACTOR);
  notifyToolsChanged();
  return backTo(c, { msg: `Deleted upstream ${name}${dependents.length ? ` and ${dependents.length} definition(s)` : ""}.` }, "#upstreams");
});

ownerRoutes.post("/owner/grants/:id/revoke", requireOwner, async (c) => {
  const id = c.req.param("id");
  const helpers = c.env.OAUTH_PROVIDER;
  if (!helpers || typeof helpers.revokeGrant !== "function") return errorPage(c, 503, "OAuth helpers are not available on this route.");
  try {
    await helpers.revokeGrant(id, "owner");
  } catch (e) {
    return errorPage(c, 500, `Could not revoke grant: ${String(e)}`);
  }
  return backTo(c, { msg: `Revoked grant ${id}. That client must sign in again.` }, "#connections");
});

ownerRoutes.get("/owner/export", requireOwner, async (c) => {
  const snapshot = await loadWebSnapshot(c.env);
  const identity = resolveIdentity(snapshot.settings, c.env, hostOf(c));
  const body = {
    exportedAt: new Date().toISOString(),
    version: VERSION,
    identity,
    catalogVersion: snapshot.catalogVersion,
    promotedBudget: snapshot.promotedBudget,
    schema: snapshot.schemaMissing ? "missing" : "ok",
    settings: snapshot.settings,
    tools: snapshot.defs.map((d) => ({
      ...d,
      input_schema: parseJson(d.input_schema),
      spec: redactValue(parseJson(d.spec)),
      annotations: parseJson(d.annotations)
    })),
    overrides: snapshot.overrides,
    upstreams: snapshot.upstreams.map((u) => ({
      name: u.name, url: u.url, auth_kind: u.auth_kind,
      headers: redactValue(parseJson(u.headers) ?? {}),
      server_info: parseJson(u.server_info),
      cached_at: u.cached_at, created_by: u.created_by, created_at: u.created_at
    }))
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${identity.name}-export.json"`, "cache-control": "no-store", "x-content-type-options": "nosniff" }
  });
});
