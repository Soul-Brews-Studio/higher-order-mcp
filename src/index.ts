// SPIKE: minimal wiring to validate OAuthProvider 0.10.3 + agents stateless handler + Hono + D1 on workerd.
import { McpServer } from "@modelcontextprotocol/server";
import { OAuthProvider, type OAuthHelpers, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { Hono } from "hono";
import { z } from "zod";

export interface Env {
  MCP_SERVER_NAME: string;
  OWNER_PASSPHRASE?: string;
  MCP_API_TOKEN?: string;
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  OAUTH_PROVIDER: OAuthHelpers;
}

function createServer(env: Env) {
  const server = new McpServer({ name: env.MCP_SERVER_NAME ?? "homcp", version: "0.1.0" });
  server.registerTool(
    "whoami",
    { title: "Who am I", description: "Return auth props for this request.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => {
      const auth = getMcpAuthContext();
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind("display_name").first<{ value: string }>();
      return { content: [{ type: "text", text: JSON.stringify({ props: auth?.props ?? null, displayName: row?.value ?? null }) }] };
    }
  );
  return server;
}

const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const handler = createMcpHandler(() => createServer(env), {
      route: "/mcp",
    });
    return handler(request, env, ctx);
  },
};

const app = new Hono<{ Bindings: Env }>();
app.get("/", (c) => c.text(`${c.env.MCP_SERVER_NAME} landing`));
app.get("/health", (c) => c.json({ ok: true, name: c.env.MCP_SERVER_NAME }));
app.get("/authorize", async (c) => {
  const req: AuthRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(req.clientId);
  if (!client) return c.text("Invalid client_id", 400);
  return c.html(`<form method="POST" action="/authorize"><input type="hidden" name="state" value="${btoa(JSON.stringify(req))}"><input name="passphrase" type="password"><button>Approve</button></form>`);
});
app.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const state = String(form.get("state") ?? "");
  const pass = String(form.get("passphrase") ?? "");
  if (!c.env.OWNER_PASSPHRASE || pass !== c.env.OWNER_PASSPHRASE) return c.text("Forbidden", 403);
  const req = JSON.parse(atob(state)) as AuthRequest;
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: req,
    userId: "owner",
    metadata: { label: "owner" },
    scope: req.scope,
    props: { userId: "owner", via: "oauth", clientId: req.clientId },
  });
  return c.redirect(redirectTo, 302);
});

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApi,
  defaultHandler: { fetch: (r: Request, e: unknown, ctx: ExecutionContext) => app.fetch(r, e as Env, ctx) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ["mcp:read", "mcp:write"],
  allowPlainPKCE: false,
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Static-token door (optional): bypass OAuth when the bearer equals MCP_API_TOKEN.
    if (url.pathname === "/mcp" && env.MCP_API_TOKEN) {
      const auth = request.headers.get("authorization") ?? "";
      if (auth === `Bearer ${env.MCP_API_TOKEN}`) {
        const handler = createMcpHandler(() => createServer(env), {
          route: "/mcp",
          authContext: { props: { userId: "owner", via: "token" } },
        });
        return handler(request, env, ctx);
      }
    }
    return provider.fetch(request, env, ctx);
  },
};
