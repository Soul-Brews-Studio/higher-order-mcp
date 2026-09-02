// src/types.ts — the cross-workstream contract. Do not add runtime code here.
import type { z } from "zod";
import type { CallToolResult, McpRequestContext, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  MCP_SERVER_NAME?: string;
  ALLOWED_HOSTNAMES?: string;
  OWNER_PASSPHRASE?: string;
  MCP_API_TOKEN?: string;
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  OAUTH_PROVIDER: OAuthHelpers;      // injected by OAuthProvider into defaultHandler requests only
  [key: `HOMCP_SECRET_${string}`]: string | undefined;
}

export type IdentitySource = "settings" | "var" | "host" | "default";
export interface Identity { name: string; title?: string; description?: string; instructions: string; source: IdentitySource }
export interface Principal { userId: "owner"; via: "oauth" | "token"; clientKey: string; clientId?: string; clientName?: string; scopes: string[] }
export interface AuthProps { userId: "owner"; via: "oauth" | "token"; clientKey: string; clientId?: string; clientName?: string; scopes?: string[]; grantedAt?: string }

export interface RequestScope {
  env: Env; ctx: ExecutionContext; url: URL; origin: string; host: string; principal: Principal;
  hop: number;                       // parsed X-Homcp-Hop (0 when absent)
  era?: McpRequestContext["era"];    // set by the factory
}

export type Layer = "builtin" | "deploy" | "client";
export type DefinedKind = "template" | "http" | "mcp" | "compose";
export type Kind = "builtin" | DefinedKind;
export type OverrideScope = "deploy" | "client";

export interface ToolDefRow { name: string; kind: DefinedKind; title: string; description: string; input_schema: string; spec: string; annotations: string; created_by: string; created_at: string; updated_at: string; version: number }
export interface ToolOverrideRow { scope: OverrideScope; client_key: string; tool_name: string; enabled: 0 | 1 | null; promoted: 0 | 1 | null; title: string | null; description: string | null; updated_by: string; updated_at: string }
export type UpstreamAuthKind = "none" | "bearer" | "secret";
export interface UpstreamRow { name: string; url: string; auth_kind: UpstreamAuthKind; auth_value: string | null; headers: string; server_info: string | null; tool_cache: string | null; cached_at: string | null; created_by: string; created_at: string }
export type SettingsMap = Record<string, string>;
export interface Snapshot { settings: SettingsMap; defs: ToolDefRow[]; overrides: ToolOverrideRow[]; upstreams: Omit<UpstreamRow, "auth_value" | "tool_cache">[]; catalogVersion: number; promotedBudget: number; schemaMissing: boolean }
export class SchemaMissingError extends Error { readonly code = "db_not_migrated" as const; }

export interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
export interface ExecContext { scope: RequestScope; catalog: ResolvedCatalog; depth: number }
export type BuiltinHandler = (args: Record<string, unknown>, exec: ExecContext) => Promise<CallToolResult>;
export interface BuiltinSpec { name: string; title: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape>; annotations: ToolAnnotations; meta?: Record<string, unknown>; protected?: boolean; hiddenByDefault?: boolean; handler: BuiltinHandler }
export interface ToolState { enabled: boolean; promoted: boolean; title: string; description: string; decidedBy: { enabled: Layer; promoted: Layer }; deployDisabled: boolean }
export interface ResolvedTool { name: string; kind: Kind; protected: boolean; annotations: ToolAnnotations; meta?: Record<string, unknown>; inputSchema: StandardSchemaWithJSON; inputSchemaJson: Record<string, unknown>; builtin?: BuiltinSpec; def?: ToolDefRow; spec?: unknown; state: ToolState }
export interface ResolvedCatalog { tools: Map<string, ResolvedTool>; visible: ResolvedTool[]; budget: { limit: number; usedDeploy: number; usedClient: number }; identity: Identity; principal: Principal; catalogVersion: number; upstreams: Snapshot["upstreams"]; schemaMissing: boolean; warnings: string[] }

export interface KindValidateContext { scope: RequestScope; catalog: ResolvedCatalog; name: string; inputSchema: Record<string, unknown> | undefined }
export type KindValidation =
  | { ok: true; inputSchema?: Record<string, unknown>; title?: string; description?: string; annotations?: Partial<ToolAnnotations>; warnings: string[] }
  | { ok: false; code: ErrorCode; message: string; hint?: string };
export interface KindModule<Spec = unknown> {
  kind: DefinedKind;
  specSchema: z.ZodType<Spec>;
  validate(spec: Spec, ctx: KindValidateContext): Promise<KindValidation>;
  defaultAnnotations(spec: Spec, ctx: KindValidateContext): ToolAnnotations;
  run(tool: ResolvedTool, input: Record<string, unknown>, exec: ExecContext): Promise<CallToolResult>;
}

export type ErrorCode =
  | "invalid_name" | "name_too_long" | "name_taken" | "unknown_tool" | "tool_disabled" | "protected_tool"
  | "not_a_definition" | "slot_budget_exceeded" | "invalid_arguments" | "schema_invalid" | "spec_invalid"
  | "unknown_upstream" | "upstream_unreachable" | "upstream_tool_missing" | "upstream_error" | "upstream_in_use"
  | "http_blocked_host" | "http_timeout" | "http_failed" | "http_too_large"
  | "compose_step_failed" | "depth_exceeded" | "hop_limit" | "db_not_migrated" | "not_found" | "forbidden" | "internal";
export interface ToolErrorBody { error: { code: ErrorCode; message: string; hint?: string; details?: unknown } }

export interface Snippets { claudeAdd: string; claudeLogin: string; claudeToken: string; codexAdd: string; codexLogin: string; claudeAiLink: string; projectMcpJson: string; pluginInstall: string; curlHealth: string }
export interface ServerInfoPayload {
  name: string; title?: string; description?: string; version: string; endpoint: string;
  auth: { oauth: { cimd: boolean; dcr: true; pkce: ["S256"] }; staticToken: boolean };
  protocol: { modern: "2026-07-28"; legacyLane: true };
  tools: { builtin: number; defined: number; promoted: number; visible: number; budget: number };
  catalogVersion: number; schema: "ok" | "missing"; snippets: Snippets; refreshHint: string;
}
