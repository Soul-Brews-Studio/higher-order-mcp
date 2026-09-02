// src/mcp/schemas.ts [B] — zod input schemas: define_tool + kind specs (§12.1 verbatim) and every built-in tool (§11).
// Every tool's inputSchema is a z.object (never a raw shape — the SDK deprecates raw shapes).
import { z } from "zod";
import { CLIENT_KEY_RE } from "./principal";

// ---------------------------------------------------------------------------------------------------------------------
// §12.1 verbatim
// ---------------------------------------------------------------------------------------------------------------------
export const hintPatch = z.object({ readOnlyHint: z.boolean(), destructiveHint: z.boolean(), idempotentHint: z.boolean(), openWorldHint: z.boolean() }).partial();
export const defineToolInput = z.object({
  name: z.string().min(1).max(64), kind: z.enum(["template", "http", "mcp", "compose"]),
  title: z.string().min(1).max(80).optional(), description: z.string().min(1).max(1500),
  input_schema: z.record(z.string(), z.unknown()).optional(),        // default {type:"object",properties:{},additionalProperties:false}
  spec: z.record(z.string(), z.unknown()), annotations: hintPatch.optional(),
  promote: z.boolean().default(false), replace: z.boolean().default(false)
});
export const specTemplate = z.object({ text: z.string().min(1).max(20_000), format: z.enum(["text", "json"]).default("text") });
export const specHttp = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), url: z.string().min(9).max(2_000),
  headers: z.record(z.string(), z.string()).default({}), body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  response: z.enum(["auto", "json", "text"]).default("auto"), json_path: z.string().max(200).optional(),
  timeout_ms: z.number().int().min(1_000).max(25_000).default(15_000), max_bytes: z.number().int().min(1_024).max(262_144).default(131_072),
  allowed_hosts: z.array(z.string()).max(8).optional()                // default [host of url]
});
export const specMcp = z.object({ upstream: z.string(), tool: z.string(), bind: z.record(z.string(), z.unknown()).default({}), schema: z.enum(["snapshot", "none"]).default("snapshot"), timeout_ms: z.number().int().min(1_000).max(20_000).default(20_000) });
export const specCompose = z.object({
  steps: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) })).min(1).max(8),
  on_error: z.enum(["stop", "continue"]).default("stop"), output: z.enum(["last", "all"]).default("last"), timeout_ms: z.number().int().min(1_000).max(45_000).default(45_000)
});

export type DefineToolInput = z.infer<typeof defineToolInput>;
export type SpecTemplate = z.infer<typeof specTemplate>;
export type SpecHttp = z.infer<typeof specHttp>;
export type SpecMcp = z.infer<typeof specMcp>;
export type SpecCompose = z.infer<typeof specCompose>;

// ---------------------------------------------------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------------------------------------------------
export const toolNameInput = z.string().min(1).max(64).describe("Tool name exactly as list_tools shows it");
export const overrideScopeInput = z.enum(["deploy", "client"]).default("deploy").describe("'deploy' = every connection (default); 'client' = one client key only");
export const clientKeyInput = z.string().regex(CLIENT_KEY_RE).describe("Client key to act for (scope 'client' only); defaults to your own key — see whoami");
export const upstreamNameInput = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).describe("Upstream name: lowercase letter first, then lowercase letters, digits, '_' or '-'; max 32");
export const emptyInput = z.object({});

// ---------------------------------------------------------------------------------------------------------------------
// meta tools (§11)
// ---------------------------------------------------------------------------------------------------------------------
export const listToolsInput = z.object({
  include_hidden: z.boolean().default(true).describe("false = only tools that are on AND listed"),
  only: z.enum(["builtin", "defined", "visible", "hidden", "disabled"]).optional().describe("Keep one group only")
});
export const describeToolInput = z.object({ name: toolNameInput });
export const callToolInput = z.object({
  name: toolNameInput,
  arguments: z.record(z.string(), z.unknown()).default({}).describe("Arguments for the target tool (its input schema: describe_tool)")
});
export const toggleToolInput = z.object({
  name: toolNameInput,
  enabled: z.boolean().optional().describe("true = on, false = off; omit to flip"),
  scope: overrideScopeInput,
  client: clientKeyInput.optional()
});
export const promoteToolInput = z.object({ name: toolNameInput, scope: overrideScopeInput, client: clientKeyInput.optional() });
export const demoteToolInput = promoteToolInput;
export const removeToolInput = z.object({ name: toolNameInput, confirm: z.literal(true).describe("Must be true — this deletes the definition and its overrides") });
export const overrideToolInput = z.object({
  name: toolNameInput,
  title: z.string().min(1).max(80).optional(),
  description: z.string().min(1).max(1500).optional(),
  reset: z.boolean().default(false).describe("true = clear the deploy-wide title/description override")
});

// ---------------------------------------------------------------------------------------------------------------------
// identity tools (§11)
// ---------------------------------------------------------------------------------------------------------------------
export const whoamiInput = emptyInput;
export const serverInfoInput = emptyInput;
export const setIdentityInput = z.object({
  name: z.string().min(1).max(32).optional().describe("New serverInfo.name: ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ (what `claude mcp add` accepts)"),
  title: z.string().max(80).optional().describe("Optional display title; empty string clears"),
  description: z.string().max(300).optional().describe("Optional one-line description; empty string clears"),
  instructions: z.string().max(1000).optional().describe("Instructions sent to clients at initialize; empty string restores the default"),
  reset: z.boolean().default(false).describe("true = clear every identity setting (back to MCP_SERVER_NAME / hostname)")
});

// ---------------------------------------------------------------------------------------------------------------------
// upstream tools (§11; handlers in src/tools/builtin/upstreams.ts [C])
// ---------------------------------------------------------------------------------------------------------------------
export const addUpstreamInput = z.object({
  name: upstreamNameInput,
  url: z.string().min(9).max(2_000).describe("https URL of the upstream MCP endpoint"),
  auth: z.object({
    kind: z.enum(["none", "bearer", "secret"]),
    value: z.string().max(4_096).optional().describe("bearer: the token (stored as plaintext); secret: NAME of the HOMCP_SECRET_NAME env secret")
  }).optional(),
  headers: z.record(z.string(), z.string()).optional().describe("Extra request headers")
});
export const removeUpstreamInput = z.object({ name: upstreamNameInput, force: z.boolean().default(false).describe("true = also delete every mcp definition that proxies this upstream") });
export const listUpstreamsInput = emptyInput;
export const upstreamToolsInput = z.object({
  upstream: upstreamNameInput,
  refresh: z.boolean().default(false).describe("true = fetch tools/list live and update the cache"),
  filter: z.string().max(100).optional().describe("Substring filter on tool names")
});

// ---------------------------------------------------------------------------------------------------------------------
// memory tools (§11; handlers in src/tools/builtin/memory.ts [D])
// ---------------------------------------------------------------------------------------------------------------------
export const memoryKind = z.enum(["note", "decision", "lesson", "context", "person", "project"]);
export const memoryTags = z.array(z.string().min(1).max(64)).max(10);
export const rememberInput = z.object({
  content: z.string().min(1).max(12_000),
  title: z.string().min(1).max(160).optional().describe("Defaults to the first line of content"),
  kind: memoryKind.default("note"),
  tags: memoryTags.optional(),
  importance: z.number().int().min(1).max(5).default(3)
});
export const recallInput = z.object({
  query: z.string().max(240).optional().describe("Full-text query; omit for the most recent/important memories"),
  kind: memoryKind.optional(),
  tag: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).default(10)
});
export const readMemoryInput = z.object({ id: z.uuid() });
export const reviseMemoryInput = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(160).optional(),
  content: z.string().min(1).max(12_000).optional(),
  kind: memoryKind.optional(),
  tags: memoryTags.optional(),
  importance: z.number().int().min(1).max(5).optional()
});
export const forgetMemoryInput = z.object({ id: z.uuid() });
export const memoryStatsInput = emptyInput;
