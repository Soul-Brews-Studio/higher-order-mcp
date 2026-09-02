// src/mcp/principal.ts [A] — the per-request principal, derived from the props the auth door put on ctx.props (§8.5).
// OAuth grants carry AuthProps written by the consent page; the static-token door writes { via:"token", clientKey:"token" }.
import type { AuthProps, Principal } from "../types";

export const CLIENT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function labelFromClientName(clientName: string | undefined): string {
  const slug = (clientName ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return CLIENT_KEY_RE.test(slug) ? slug : "client";
}
export function principalFromProps(props: unknown): Principal {
  const p = (props && typeof props === "object" ? props : {}) as Partial<AuthProps>;
  const via = p.via === "token" ? "token" : "oauth";
  const key = typeof p.clientKey === "string" && CLIENT_KEY_RE.test(p.clientKey) ? p.clientKey : via === "token" ? "token" : "unlabeled";
  return { userId: "owner", via, clientKey: key, clientId: p.clientId, clientName: p.clientName, scopes: Array.isArray(p.scopes) ? p.scopes.filter((s): s is string => typeof s === "string") : [] };
}
