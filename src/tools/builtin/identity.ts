// src/tools/builtin/identity.ts [B] — whoami, server_info, set_identity (§9, §11).
// server_info returns E's serverInfoPayload (src/web/snippets.ts) — the same payload as GET /api/info — and set_identity
// reuses installSnippets so the suggested `claude mcp add` line is the one the landing page prints.
import type { z } from "zod";
import { IDENTITY_NAME_RE, resolveIdentity, validateIdentityName } from "../../identity";
import { notifyToolsChanged } from "../../mcp/handler";
import { fail, ok, withRefreshHint } from "../../mcp/result";
import { serverInfoInput, setIdentityInput, whoamiInput } from "../../mcp/schemas";
import { isSchemaMissing, loadSnapshot, setSettings } from "../../registry/db";
import { nameBudget } from "../../registry/names";
import { resolveCatalog } from "../../registry/resolve";
import type { BuiltinSpec } from "../../types";
import { cimdEnabled, installSnippets, serverInfoPayload } from "../../web/snippets";
import { actorOf, builtinsOf, dbNotMigrated, guarded } from "./meta";

/** §9 in prose — returned by set_identity so the model can explain what did and did not change. Examples are neutral (check-names guard). */
export const THREE_NAMES = [
  "Three names matter, one does not:",
  "1. Worker name / hostname — the Deploy button's Project name or wrangler.jsonc `name`; it is the URL https://<name>.<subdomain>.workers.dev/mcp (or a custom domain). Changing it is a redeploy.",
  "2. Instance identity — this setting: serverInfo.name, the approval page, landing page, /health, /api/info, whoami and server_info. Precedence: D1 setting (set_identity / owner console) → non-empty MCP_SERVER_NAME var → first DNS label of the host (my-memory.example.com → my-memory) → homcp. Renaming it never touches tool names, D1/KV data, tokens or the owner cookie, and needs no redeploy.",
  "3. Client key — what the user typed: `claude mcp add <key>` or the .mcp.json key (tool prefix mcp__<key>__), the claude.ai connector Name, `codex mcp add <name>`. Renaming here does not rename existing client entries or connectors; every key character costs one tool-name character (len(tool) <= 121 - len(key)).",
  "— McpServer title is optional and shown by no client today."
].join("\n");

// ---------------------------------------------------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------------------------------------------------
const whoami: BuiltinSpec = {
  name: "whoami",
  title: "Who am I",
  description: "Who is calling: how you authenticated (oauth or static token), your client key (the per-connection override scope), OAuth client id/name and scopes, the protocol era, request host, server identity, hop count and how many client-scope overrides your key has.",
  inputSchema: whoamiInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(_args, exec) {
    const { scope, catalog } = exec;
    const p = scope.principal;
    let clientOverrides: number | null = null;
    if (!catalog.schemaMissing) {
      try {
        const r = await scope.env.DB.prepare("SELECT count(*) AS n FROM tool_overrides WHERE scope='client' AND client_key=?1").bind(p.clientKey).first<{ n: number }>();
        clientOverrides = Number(r?.n ?? 0);
      } catch (e) { if (!isSchemaMissing(e)) throw e; }
    }
    const text = [
      `You are ${p.userId}, connected via ${p.via} as client key \`${p.clientKey}\`${p.clientName ? ` (client: ${p.clientName}${p.clientId ? `, id ${p.clientId}` : ""})` : ""}; scopes: ${p.scopes.length ? p.scopes.join(" ") : "(none)"}.`,
      `Server identity: ${catalog.identity.name} (source: ${catalog.identity.source}) at ${scope.host} · protocol era: ${scope.era ?? "unknown"} · hop ${scope.hop} · client overrides for your key: ${clientOverrides ?? "n/a"}.`,
      `Overrides you make with scope "client" apply to \`${p.clientKey}\` only; scope "deploy" applies to every connection.`
    ].join("\n");
    return ok(text, {
      principal: { userId: p.userId, via: p.via, clientKey: p.clientKey, clientId: p.clientId ?? null, clientName: p.clientName ?? null, scopes: p.scopes },
      era: scope.era ?? null, host: scope.host, origin: scope.origin,
      identity: { name: catalog.identity.name, source: catalog.identity.source, title: catalog.identity.title ?? null },
      hop: scope.hop, clientOverrides, catalogVersion: catalog.catalogVersion
    });
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// server_info
// ---------------------------------------------------------------------------------------------------------------------
const serverInfo: BuiltinSpec = {
  name: "server_info",
  title: "Server info",
  description: "Everything needed to install or debug this server: identity, version, endpoint, auth capabilities (CIMD, DCR, PKCE, static token), protocol lanes, tool counts and budget, catalog_version, schema status, ready-to-paste install snippets and the refresh hint. Same payload as GET /api/info.",
  inputSchema: serverInfoInput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(_args, exec) {
    const payload = serverInfoPayload(exec.catalog, exec.scope, { cimd: cimdEnabled() });
    const s = payload.snippets;
    const text = [
      `${payload.name} v${payload.version} — ${payload.endpoint}`,
      `auth: OAuth (CIMD ${payload.auth.oauth.cimd ? "on" : "off"}, DCR, PKCE S256)${payload.auth.staticToken ? " + static token" : ""} · protocol: ${payload.protocol.modern} + legacy lane · schema: ${payload.schema}`,
      `tools: ${payload.tools.visible} visible · ${payload.tools.builtin} built-in · ${payload.tools.defined} defined (${payload.tools.promoted} promoted, budget ${payload.tools.budget}) · catalog_version ${payload.catalogVersion}`,
      "",
      "Claude Code:", `  ${s.claudeAdd}`, `  ${s.claudeLogin}`,
      "claude.ai:", `  ${s.claudeAiLink}`,
      "Codex:", `  ${s.codexAdd} && ${s.codexLogin}`,
      "Health:", `  ${s.curlHealth}`
    ].join("\n");
    return withRefreshHint(ok(text, payload as unknown as Record<string, unknown>));
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// set_identity
// ---------------------------------------------------------------------------------------------------------------------
const setIdentity: BuiltinSpec = {
  name: "set_identity",
  title: "Set identity",
  description: "Rename this server without redeploying: stores serverInfo.name (and optional title, description, instructions) in the database, which wins over the MCP_SERVER_NAME var. Tool names, data and tokens are untouched; client keys keep whatever the user typed. reset:true returns to the var/hostname default.",
  inputSchema: setIdentityInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, exec) => guarded(async () => {
    const { name, title, description, instructions, reset } = args as z.infer<typeof setIdentityInput>;
    const { scope, catalog } = exec;
    if (catalog.schemaMissing) return dbNotMigrated();
    const values: Record<string, string | null> = {};
    if (reset) {
      values.identity_name = null; values.identity_title = null; values.identity_description = null; values.identity_instructions = null;
    } else {
      if (name !== undefined) {
        const err = validateIdentityName(name);
        if (err || !IDENTITY_NAME_RE.test(name)) return fail("invalid_name", err ?? `'${name}' is not a valid identity name.`, "Use ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ — exactly what `claude mcp add <key>` accepts.");
        values.identity_name = name;
      }
      if (title !== undefined) values.identity_title = title.trim() || null;
      if (description !== undefined) values.identity_description = description.trim() || null;
      if (instructions !== undefined) values.identity_instructions = instructions.trim() || null;
      if (Object.keys(values).length === 0) return fail("invalid_arguments", "Nothing to change.", "Pass name, title, description or instructions — or reset:true.");
    }
    await setSettings(scope.env.DB, values, actorOf(exec));
    notifyToolsChanged();

    const snap = await loadSnapshot(scope.env.DB, scope.principal.clientKey);
    const identity = resolveIdentity(snap.settings, scope.env, scope.host);
    const after = resolveCatalog(builtinsOf(catalog), snap, scope.principal, identity);
    const budget = nameBudget(identity.name);
    const overBudget = snap.defs.filter((d) => d.name.length > budget).map((d) => ({ name: d.name, length: d.name.length }));
    const snippets = installSnippets(identity, scope.origin);
    const text = [
      `Identity is now \`${identity.name}\` (source: ${identity.source})${identity.title ? `, title "${identity.title}"` : ""}. The next initialize reports it as serverInfo.name; no redeploy needed.`,
      `Tool-name budget for this identity: ${budget} chars.${overBudget.length ? ` Definitions now over budget (kept, but rename them): ${overBudget.map((o) => `${o.name} (${o.length})`).join(", ")}.` : " Every definition fits."}`,
      `Suggested client key: ${identity.name} → ${snippets.claudeAdd}`,
      "",
      THREE_NAMES
    ].join("\n");
    return withRefreshHint(ok(text, {
      identity: { name: identity.name, source: identity.source, title: identity.title ?? null, description: identity.description ?? null, instructions: identity.instructions },
      nameBudget: budget, overBudget, snippets, catalogVersion: after.catalogVersion
    }));
  })
};

export const identityTools: BuiltinSpec[] = [whoami, serverInfo, setIdentity];
