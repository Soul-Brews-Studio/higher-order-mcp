// src/web/app.tsx [A+E] — the Hono app behind OAuthProvider's defaultHandler (§15): landing, /health, /api/info, /sse (410),
// the consent page, the owner console, 404 JSON. Everything the pages show is derived from the same snapshot → identity →
// resolveCatalog pipeline the MCP factory uses, so the web and the tools never disagree.
import { Hono } from "hono";
import { resolveIdentity } from "../identity";
import { loadSnapshot, emptySnapshot } from "../registry/db";
import { resolveCatalog } from "../registry/resolve";
import { BUILTINS } from "../tools/builtin";
import { consentGet, consentPost } from "./consent";
import { ownerRoutes } from "./owner";
import { renderLanding } from "./landing";
import { PAGE_HEADERS } from "./layout";
import { WEB_CLIENT_KEY, cimdEnabled, healthPayload, serverInfoPayload } from "./snippets";
import { SchemaMissingError, type Env, type Principal, type RequestScope, type ResolvedCatalog } from "../types";

export const webApp = new Hono<{ Bindings: Env }>();

/** The principal public pages resolve the catalog with: an unlabeled OAuth-shaped principal keyed `web` (never stores overrides). */
const WEB_PRINCIPAL: Principal = { userId: "owner", via: "oauth", clientKey: WEB_CLIENT_KEY, scopes: [] };

/** A RequestScope for a web request (hop 0, no era). */
export function webScope(request: Request, env: Env, ctx: ExecutionContext): RequestScope {
  const url = new URL(request.url);
  return { env, ctx, url, origin: url.origin, host: url.host, principal: WEB_PRINCIPAL, hop: 0 };
}
/** snapshot → identity → catalog, tolerating a not-yet-migrated database (built-in-only catalog + schemaMissing). */
export async function webCatalog(scope: RequestScope): Promise<ResolvedCatalog> {
  let snapshot;
  try { snapshot = await loadSnapshot(scope.env.DB, scope.principal.clientKey); }
  catch (e) { if (!(e instanceof SchemaMissingError)) throw e; snapshot = emptySnapshot(); }
  const identity = resolveIdentity(snapshot.settings, scope.env, scope.host);
  return resolveCatalog(BUILTINS, snapshot, scope.principal, identity);
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

webApp.get("/", async (c) => {
  const scope = webScope(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext);
  const catalog = await webCatalog(scope);
  return new Response(renderLanding(catalog, scope, { cimd: cimdEnabled() }), { status: 200, headers: PAGE_HEADERS });
});

webApp.get("/health", async (c) => {
  const catalog = await webCatalog(webScope(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext));
  return new Response(JSON.stringify(healthPayload(catalog, { cimd: cimdEnabled() })), { status: 200, headers: JSON_HEADERS });
});

webApp.get("/api/info", async (c) => {
  const scope = webScope(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext);
  const catalog = await webCatalog(scope);
  return new Response(JSON.stringify(serverInfoPayload(catalog, scope, { cimd: cimdEnabled() })), { status: 200, headers: JSON_HEADERS });
});

/** The SSE transport is retired (D11): Streamable HTTP lives at exactly /mcp. */
webApp.all("/sse", () =>
  new Response(JSON.stringify({ type: "about:blank", title: "SSE transport retired", status: 410, detail: "Use Streamable HTTP at /mcp" }), {
    status: 410,
    headers: { "content-type": "application/problem+json", link: '</mcp>; rel="alternate"', "cache-control": "no-store" }
  })
);

// §13 consent — the OAuthProvider routes /authorize here (authorizeEndpoint) with env.OAUTH_PROVIDER injected.
webApp.get("/authorize", consentGet);
webApp.post("/authorize", consentPost);

// §13 owner console — workstream E's routes (absolute /owner, /owner/login, /owner/logout, /owner/identity, /owner/tools/:name,
// /owner/upstreams/:name/delete, /owner/grants/:id/revoke, /owner/export); mounted at the root so their paths stay absolute.
webApp.route("/", ownerRoutes);

webApp.notFound((c) => c.json({ error: "not_found" }, 404));
webApp.onError((err, c) => {
  console.error("web", c.req.method, c.req.path, String(err));
  return c.json({ error: "internal", detail: "Unexpected error." }, 500);
});
