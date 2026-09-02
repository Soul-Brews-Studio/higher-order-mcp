// src/worker.ts [A] — the Worker entry (§8.1). The optional static bearer (MCP_API_TOKEN) is checked here, BEFORE the
// OAuthProvider, because the provider 401s any bearer that is not one of its grants (oauth-provider.js:2675). A match
// sets ctx.props exactly the way the provider does for OAuth tokens, so the MCP handler sees one principal shape.
import { provider } from "./oauth/provider";
import { mcpApiHandler } from "./mcp/handler";
import { constantTimeEqual } from "./web/session";
import type { AuthProps, Env } from "./types";
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" && env.MCP_API_TOKEN) {
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (bearer && (await constantTimeEqual(bearer, env.MCP_API_TOKEN))) {
        const props: AuthProps = { userId: "owner", via: "token", clientKey: "token", clientName: "static token", scopes: [] };
        (ctx as ExecutionContext & { props?: unknown }).props = props;   // same field OAuthProvider sets (oauth-provider.js:2702); agents reads it (handler-stateless:293)
        return mcpApiHandler.fetch(request, env, ctx);
      }
    }
    return provider.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
