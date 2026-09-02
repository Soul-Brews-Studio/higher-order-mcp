// src/oauth/provider.ts [A] — the single module-scope OAuthProvider (§8.2, D2). PRM `resource` is derived per host from
// the path-suffixed well-known URL (no resourceMetadata.resource, spike-verified with claude.ai and Claude Code);
// no scopesSupported (grant what is requested). CIMD is advertised only when global_fetch_strictly_public is on.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { mcpApiHandler } from "../mcp/handler";
import { webApp } from "../web/app";
import type { Env } from "../types";
export const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler,                                    // {fetch} object, never a bare function
  defaultHandler: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => webApp.fetch(req, env, ctx) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",                // DCR fallback
  clientIdMetadataDocumentEnabled: true,                        // advertised only with global_fetch_strictly_public
  allowPlainPKCE: false,
  accessTokenTTL: 3600,
  refreshTokenTTL: 60 * 60 * 24 * 30,
  clientRegistrationTTL: 60 * 60 * 24 * 90,
  onError: (e) => { console.warn("oauth", e.code, e.status, e.internal?.category ?? "", e.description); }
});
// No resourceMetadata.resource (PRM derived per host; spike-verified) and no scopesSupported (grant what is requested; T pattern).
