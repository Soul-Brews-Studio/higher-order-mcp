// src/identity.ts [A] — instance identity (§9): the name a deployment calls itself.
// Precedence: D1 settings.identity_name → non-empty var MCP_SERVER_NAME → first DNS label of the request Host → "homcp".
// The regex is exactly what `claude mcp add <key>` accepts, so "key = identity" install snippets always work.
import type { Env, Identity, IdentitySource, SettingsMap } from "./types";

export const IDENTITY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const DEFAULT_INSTRUCTIONS = (name: string) =>
  `${name} is a higher-order MCP server: it can create, hide, show and proxy tools at runtime. ` +
  `Call list_tools to see every tool including hidden ones, describe_tool for a tool's schema, and call_tool {name, arguments} to run a tool that is not in your tool list. ` +
  `define_tool creates tools (kinds: template, http, mcp, compose) that start hidden; promote_tool lists them; toggle_tool switches tools on/off. ` +
  `Use remember/recall for notes the user wants kept. After changing tools, refresh your tool list.`;

/** First DNS label of a Host header as an identity name, or null (localhost, IP literals, unusable labels). */
export function hostLabel(host: string): string | null {
  const h = host.toLowerCase().split(":")[0];
  if (!h || h === "localhost" || /^[\d.]+$/.test(h) || h.startsWith("[")) return null;
  const label = h.split(".")[0].replace(/[^a-z0-9_-]/g, "-").replace(/^[-_]+/, "").slice(0, 32);
  return IDENTITY_NAME_RE.test(label) ? label : null;
}

export function resolveIdentity(settings: SettingsMap, env: Env, host: string): Identity {
  const fromSettings = settings.identity_name; const fromVar = env.MCP_SERVER_NAME?.trim();
  const [name, source]: [string, IdentitySource] =
    fromSettings && IDENTITY_NAME_RE.test(fromSettings) ? [fromSettings, "settings"]
    : fromVar && IDENTITY_NAME_RE.test(fromVar) ? [fromVar, "var"]
    : (hostLabel(host) ? [hostLabel(host)!, "host"] : ["homcp", "default"]);
  return { name, source, title: settings.identity_title || undefined, description: settings.identity_description || undefined,
    instructions: (settings.identity_instructions || DEFAULT_INSTRUCTIONS(name)).slice(0, 1000) };
}

/** Returns a human-readable problem, or null when the name is acceptable as an identity (and as a `claude mcp add` key). */
export function validateIdentityName(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return "Identity name is required.";
  if (name.length > 32) return `Identity name is ${name.length} characters; the maximum is 32.`;
  if (!IDENTITY_NAME_RE.test(name)) {
    return `'${name}' is not a valid identity name: start with a letter or digit and use only letters, digits, '-' and '_' (no spaces or dots). ` +
      "This is exactly what `claude mcp add <key>` accepts, so the landing-page snippets keep working.";
  }
  return null;
}

/** The identity_* settings rows in one narrow SELECT. A missing schema (not migrated) yields {} instead of throwing. */
export async function loadIdentitySettings(db: D1Database): Promise<SettingsMap> {
  try {
    const { results } = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'identity_%'").all<{ key: string; value: string }>();
    const out: SettingsMap = {};
    for (const row of results ?? []) out[row.key] = row.value;
    return out;
  } catch (e) {
    if (/no such table/i.test(String(e))) return {};
    throw e;
  }
}
