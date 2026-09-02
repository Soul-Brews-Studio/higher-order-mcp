// src/scope.ts [W0] — per-request scope carried through AsyncLocalStorage (D4): env, principal, hop, era.
// The MCP handler is a lazy module singleton, so nothing request-specific may live in module state;
// mcpApiHandler.fetch runs the handler inside requestScope.run(scope, ...) and the factory reads it once.
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestScope } from "./types";

export const requestScope = new AsyncLocalStorage<RequestScope>();

/** The current request's scope. Throws outside a request (i.e. outside requestScope.run). */
export function getScope(): RequestScope {
  const scope = requestScope.getStore();
  if (!scope) throw new Error("no request scope");
  return scope;
}
