// src/mcp/handler.ts [A] — the /mcp entry (§8.3). One lazy module-singleton createMcpHandler (D4) so notify.toolsChanged()
// reaches every stream of this isolate; per-request env/principal/hop travel through requestScope (AsyncLocalStorage)
// and are read once by the factory. ctx.props is the field OAuthProvider sets (oauth-provider.js:2702) and the static
// door sets in worker.ts; agents reads it (handler-stateless:293).
import { createMcpHandler } from "agents/mcp/server";
import { requestScope, getScope } from "../scope";
import { buildServer } from "./factory";
import { principalFromProps } from "./principal";
import type { Env, RequestScope } from "../types";
type Handler = ReturnType<typeof createMcpHandler>;
let handler: Handler | undefined;
function getHandler(env: Env): Handler {
  return (handler ??= createMcpHandler((mcpCtx) => buildServer(mcpCtx, getScope()), {
    route: "/mcp",
    allowedHostnames: env.ALLOWED_HOSTNAMES?.split(",").map((s) => s.trim()).filter(Boolean) || undefined,
    onerror: (e) => console.error("mcp", e)
  }));
}
export function notifyToolsChanged(): void { try { handler?.notify.toolsChanged(); } catch (e) { console.warn("notify", e); } }
export const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hop = Number.parseInt(request.headers.get("x-homcp-hop") ?? "0", 10);
    const scope: RequestScope = { env, ctx, url, origin: url.origin, host: url.host,
      principal: principalFromProps((ctx as ExecutionContext & { props?: unknown }).props), hop: Number.isFinite(hop) && hop > 0 ? hop : 0 };
    return requestScope.run(scope, () => getHandler(env)(request, env, ctx));
  }
};
