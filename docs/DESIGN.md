# homcp — FINAL DESIGN (v1, synthesized 2026-09-02)

Full text with every verbatim artifact is at `/private/tmp/claude-507/-opt-Code-github-com-Soul-Brews-Studio-higher-order-mcp-lab-oracle/1ae82f71-7b36-4565-9a99-37a1ed4d4a0f/scratchpad/DESIGN.md` (this string is that file).

Working name `homcp` (package `higher-order-mcp`); a deployed instance is named like `thor-memory`. Target repo: `/opt/Code/github.com/Soul-Brews-Studio/higher-order-mcp-lab-oracle` (spike commit `69150bf` already proves the shell; `node_modules` populated).

Provenance: the two judges split (J1: proven-min 82 / registry-core 79; J2: registry-core 83 / proven-min 80 — a 162:162 tie). This document is the merge both judges asked for: **proven-min's shell** (the shape already deployed and connected from claude.ai AND Claude Code — `docs/evidence/spike-2026-09-02.md`) carrying **registry-core's registry** (one override mechanism, pure resolver with provenance, `catalog_version`, error-code contract, hop guard, http host policy, upstream fetch seam), plus the product-ux grafts (ten-minute journey, `connect-mcp.sh project`, grep-guard, `data-testid` snippets). Every fatal flaw listed by the judges is fixed (§0.1).

Evidence keys: T=`arra-memory-cloudflare-template`, L=`arra-memory-lab`, H=`arra-memory-haos/arra-memory/src`, D=`digger-oracle/ψ/lab/session-viewer/docs/HIGHER-ORDER-MCP.md`, NM=target `node_modules`, SP=scratchpad, SPIKE=`docs/evidence/spike-2026-09-02.md`, LIVE=orchestrator's verified-live list, GAP=`SP/phase1-gaps-filled.json`, GDOC=`SP/phase1-gaps-docs.json`.

---

## 0. What changed versus the three drafts

### 0.1 Judge-found flaws and their fixes

| Flaw (judge) | Fix |
|---|---|
| `tsconfig.types` `@cloudflare/workers-types/2023-07-01` does not exist; pool root types do not declare `cloudflare:test` (all three) | `types: ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"]` (judge-verified with tsc); `node:async_hooks` typed by a 6-line local shim (`src/node-shims.d.ts`) instead of `@types/node` (collides with workers-types globals); `vitest.config.ts` excluded from `tsc` |
| No cross-request loop guard for mcp-kind self-proxy; loopback test unreachable (proven-min) | `X-Homcp-Hop` header set by the per-request upstream `Client`, read at the `/mcp` entry, `hop >= 3` → `hop_limit`; `outbound.fetch` seam (`src/registry/upstream.ts`) swapped to `SELF.fetch` in tests — pool-workers runs the main Worker "in the same isolate/context as tests" (`NM/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts:9-11`) |
| http kind lets a param change the host while secrets ride along (proven-min) | Define-time: https only, no literal IP / `localhost` / `*.internal` / `*.local`; `allowed_hosts` defaults to `[url host]`; rendered host re-checked at call time; `{{secret:NAME}}` only in `url`/`headers`, never echoed |
| deploy.mjs temp-config dance breaks `migrations_dir` resolution (registry-core) | Two plain calls: `wrangler deploy` → `wrangler d1 migrations apply DB --remote` (spike-proven on id-less bindings; wrangler resolves DB by `database_name`) |
| `.env.example` leaves `MCP_API_TOKEN=` uncommented → button demands it | Only `OWNER_PASSPHRASE` uncommented (GDOC: button prompts for every uncommented line) |
| Runtime `ensureSchema()` re-running migrations (registry-core) | No runtime DDL. Schema missing ⇒ builtin-only catalog, `db_not_migrated` tool errors, `/health` `schema:"missing"`, landing yellow box |
| `defineWorkersConfig` from a non-existent subpath (product-ux) | `cloudflareTest` + `readD1Migrations` from the package root (spike config, 5/5 passing) |
| Identity accepts spaces/dots yet landing says key == identity (product-ux) | Identity name `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` — exactly what `claude mcp add` accepts (GAP E5) |
| Tool names may contain `.` which Claude Code sanitizes to `_` | Tool name charset `[A-Za-z0-9_-]`, no dot |
| `MCP_SERVER_NAME` shipped as `"homcp"` kills the host fallback; button never rewrites `vars` | Var ships as `""`; precedence D1 setting → non-empty var → host label → `"homcp"` (SP/userrepos/*.cfg: button rewrites `name`/ids, never `vars`) |
| Resolve-time budget cut silently hides promoted tools | Budget enforced only at `promote_tool`; `list_tools` warns when over budget |
| 60 s compose budget ≥ Claude Code 60 s request timeout | compose 45 s, http ≤ 25 s, mcp connect 10 s + call 20 s |
| Unknown Host → 403 until `ALLOWED_HOSTNAMES` set | agents' default: no Host check on custom domains; `ALLOWED_HOSTNAMES` optional hardening |

### 0.2 Grafts taken
From registry-core: `tool_overrides(scope, client_key, tool_name)`; pure `resolveCatalog` with `decidedBy`; `catalog_version`; one `db.batch` snapshot per request; `invoke()` single dispatch path; error-code contract; JSON-Schema `input_schema` via SDK `fromJsonSchema`; hop guard; http policy; `withUpstream` seam; `IF NOT EXISTS` DDL.
From proven-min: shell (`OAuthProvider` without `resourceMetadata.resource`, static door before the provider via `ctx.props`, lazy module-singleton handler + ALS scope), `.dev.vars.example` with one required secret, two-step deploy script, KV rate limit on consent/login, `disable()`-registration of hidden tools, `_meta["anthropic/requiresUserInteraction"]` on destructive tools, `/sse` 410.
From product-ux: ten-minute journey README, live-origin landing snippets with `data-testid`, `connect-mcp.sh project`, "same name in more than one scope" note, baked-in-name guard script.
Dropped: built-in aliases, `api_tokens` table, consent scope checkboxes, per-origin providers/strict RFC 8707 audience.

---

## 1. Goals and non-goals

Goals: (1) public Deploy-to-Cloudflare template that connects to claude.ai (custom connector, CIMD) and Claude Code (`claude mcp add --scope user` + `claude mcp login`) first try; (2) renameable per deploy without touching data or tool names; (3) stateless MCP on exactly `/mcp`, 2026-07-28 modern lane + 2025 legacy lane; (4) BUILTIN → DEPLOY → CLIENT layering resolved per request, deterministic `tools/list`; (5) higher-order tools at runtime (define template/http/mcp/compose, describe, toggle, promote/demote with budget, remove, generic `call_tool`, upstreams, identity); (6) memory core; (7) install surfaces (README button, landing snippets, `connect-mcp.sh`, plugin, claude.ai prefill link, project override).
Non-goals: cross-isolate `list_changed` fan-out; Durable Objects; McpAgent; elicitation/sampling; multi-user auth; Vite/React; tool aliases; per-tool API tokens.

---

## 2. Decision table

| # | Decision | Why |
|---|---|---|
| D1 | `agents@0.22.0` `createMcpHandler` (stateless, `legacy:"stateless"`) over `@modelcontextprotocol/server@2.0.0`, wrapped by `@cloudflare/workers-oauth-provider@0.10.3`; Hono 4.13.5 + `hono/jsx`; no Vite | SPIKE proves this exact stack; agents peer-pins server 2.0.0; legacy lane for claude.ai (2025-06-18); Claude Code 2.1.257 takes the modern lane |
| D2 | One module-scope `OAuthProvider`; PRM `resource` derived from the path-suffixed well-known URL (no `resourceMetadata.resource`) | SPIKE: PRM `resource` == typed URL, both clients connected; strict audience would pin tokens to one host |
| D3 | Static bearer `MCP_API_TOKEN` checked in `worker.ts` before the provider; principal via `ctx.props` | provider 401s any non-grant bearer (`oauth-provider.js:2675`); agents reads `workerCtx.props` (`handler-stateless-VvrWSAVA.js:293`) — the field the provider sets at `:2702` |
| D4 | Lazy module-singleton MCP handler; `env`/principal/hop travel through `AsyncLocalStorage<RequestScope>` read once in the factory | `notify` reaches only streams of the same handler instance (SP/handler-api.md:330-346); factory awaited inside fetch (`handler-stateless:104-106`) |
| D5 | Registry + memories + settings in D1; KV only for OAuth state, owner sessions, rate limits | KV eventually consistent up to 60 s; D1 single primary (GDOC d1) |
| D6 | `tools/list` from one `db.batch` snapshot, `ORDER BY name`, `cacheHints {ttlMs:0, cacheScope:"private"}` | spec 2026-07-28 tools MAY vary by authorization, MUST NOT vary per connection |
| D7 | Layers BUILTIN → DEPLOY (`tool_overrides` scope=deploy) → CLIENT (scope=client, `client_key` = consent label / `token`); `enabled` narrows downward only; `promoted` overridden per layer; PROTECTED forces both true | L scope catalogs + H deploy toggles as prior art; only `getMcpAuthContext().props` reliable |
| D8 | Defined tools callable at once via `call_tool`, hidden until `promote_tool` (budget 12) | D recipe; H `MAX_GENERATED_TOOLS=12`; generated tools were 61 % of context |
| D9 | Tool names `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, budget `min(64, 121 − len(identity))`, collisions rejected at creation | full name ≤ 128 or API 400 (GAP E9/E10); `.`→`_` aliasing (GAP E2) |
| D10 | listChanged advertised + `notify.toolsChanged()` after every mutation + refresh hint + `catalog_version` | isolate-local; LIVE: fan-out not required |
| D11 | Endpoint exactly `/mcp`; `/sse` → 410 | claude-ai-mcp#878; agents 404s other paths |
| D12 | `wrangler.jsonc` without ids/routes/assets; `deploy` = `wrangler deploy` then `wrangler d1 migrations apply DB --remote` | SPIKE auto-provisioned id-less KV/D1; button rewrites `name`/ids; migrations by binding per Cloudflare docs |
| D13 | vitest 4.1.11 + pool-workers 0.22.0 (`cloudflareTest`, `readD1Migrations`/`applyD1Migrations`), all through `SELF.fetch("https://homcp.test/...")` | spike suite passes; `homcp.test` skips agents' Host check |

---

## 3. Stack (exact versions)
`agents` 0.22.0 · `@modelcontextprotocol/server` 2.0.0 (`fromJsonSchema` exported, raw-shape inputSchema deprecated → always `z.object()`) · `@modelcontextprotocol/client` 2.0.0 (`StreamableHTTPClientTransport` `{requestInit, fetch}`, `versionNegotiation.mode:'auto'`) · `@cloudflare/workers-oauth-provider` 0.10.3 · `hono` 4.13.5 · `zod` 4.5.4 · dev: `wrangler` 4.128.0, `typescript` 7.0.2, `vitest` 4.1.11, `@cloudflare/vitest-pool-workers` 0.22.0, `@cloudflare/workers-types` 5.20260901.1. Flags `nodejs_compat`, `global_fetch_strictly_public`; compat date `2026-08-21`.

---

## 4. Repository layout (owner workstream in brackets)

```
wrangler.jsonc package.json tsconfig.json vitest.config.ts .dev.vars.example .env.example .gitignore LICENSE            [W0]
migrations/0001_registry.sql migrations/0002_memory.sql                                                                [W0]
src/types.ts (§7)  src/node-shims.d.ts  src/version.ts  src/scope.ts  src/mcp/result.ts  test/setup.ts test/helpers.ts   [W0]
src/worker.ts src/oauth/provider.ts src/mcp/handler.ts src/mcp/factory.ts src/mcp/principal.ts src/identity.ts         [A]
src/web/app.tsx (routes + consent wiring) src/web/consent.tsx src/web/session.ts                                        [A]
src/registry/db.ts src/registry/resolve.ts src/registry/names.ts src/registry/dispatch.ts src/mcp/schemas.ts           [B]
src/tools/builtin/index.ts src/tools/builtin/meta.ts src/tools/builtin/forge.ts src/tools/builtin/identity.ts          [B]
src/registry/upstream.ts src/registry/kinds/{index,template,http,mcp,compose}.ts src/util/template.ts src/util/json-path.ts src/tools/builtin/upstreams.ts [C]
src/memory/store.ts src/tools/builtin/memory.ts                                                                         [D]
src/web/layout.tsx src/web/landing.tsx src/web/owner.tsx src/web/snippets.ts README.md docs/*.md scripts/* plugin/* .claude-plugin/marketplace.json examples/project.mcp.json [E]
test/stateless,auth,consent,identity [A] · test/names,resolve,registry [B] · test/template,kinds,upstreams [C] · test/memory [D] · test/web,owner [E]
docs/evidence/spike-2026-09-02.md (keep) · src/index.ts + test/smoke.test.ts (spike; deleted in W0)
```

---

## 5. Configuration files (verbatim)

### 5.1 `wrangler.jsonc`
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "homcp",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-21",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "workers_dev": true,
  "observability": { "enabled": true },
  "vars": {
    "MCP_SERVER_NAME": ""
  },
  "kv_namespaces": [
    { "binding": "OAUTH_KV" }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "homcp", "migrations_dir": "migrations" }
  ]
}
```
No ids (wrangler ≥ 4.45 provisions and links by binding; the button rewrites `name`/ids in the clone, never `vars`); no `routes`; no `assets`. Optional hardening var `ALLOWED_HOSTNAMES` is read if present but not shipped.

### 5.2 `package.json`
```json
{
  "name": "higher-order-mcp",
  "version": "0.1.0",
  "description": "Renameable, OAuth-capable, stateless higher-order MCP server template for Cloudflare Workers (Deploy to Cloudflare).",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "node scripts/deploy.mjs",
    "deploy:dry-run": "node scripts/deploy.mjs --dry-run",
    "db:migrate:local": "wrangler d1 migrations apply DB --local",
    "db:migrate:remote": "wrangler d1 migrations apply DB --remote",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "check": "node scripts/check-names.mjs && tsc --noEmit && vitest run",
    "types": "wrangler types env.d.ts --include-runtime false",
    "mcp:connect": "./scripts/connect-mcp.sh"
  },
  "dependencies": {
    "@cloudflare/workers-oauth-provider": "0.10.3",
    "@modelcontextprotocol/client": "2.0.0",
    "@modelcontextprotocol/server": "2.0.0",
    "agents": "0.22.0",
    "hono": "4.13.5",
    "zod": "4.5.4"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "0.22.0",
    "@cloudflare/workers-types": "5.20260901.1",
    "typescript": "7.0.2",
    "vitest": "4.1.11",
    "wrangler": "4.128.0"
  },
  "cloudflare": {
    "bindings": {
      "OWNER_PASSPHRASE": { "description": "Required. The passphrase you type on the OAuth approval page when claude.ai or Claude Code connects, and to open the owner console at /owner. Generate with: `openssl rand -base64 24`. MCP clients never see it; they receive revocable OAuth tokens." },
      "MCP_API_TOKEN": { "description": "Optional. A long random static bearer for headless clients (cron, CI, Codex without OAuth). Leave unset to keep OAuth as the only door; add later with `wrangler secret put MCP_API_TOKEN`." },
      "MCP_SERVER_NAME": { "description": "Optional. What this deployment calls itself (serverInfo.name, approval-page and landing-page copy, default key in install snippets), e.g. `thor-memory`. Letters, digits, `-` and `_` only. Empty = derive from the hostname. Can be changed later without redeploying via the `set_identity` tool or the owner console." },
      "OAUTH_KV": { "description": "Cloudflare creates and binds this KV namespace automatically. Stores OAuth clients, grants, hashed tokens, owner-console sessions and rate-limit counters." },
      "DB": { "description": "Cloudflare creates and binds this D1 database automatically. Stores the tool registry (defined tools, per-deploy and per-client overrides, upstream MCP servers, settings, audit) and memories. Migrations run from the deploy script by binding name." }
    }
  }
}
```

### 5.3 `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"],
    "strict": true, "noEmit": true, "skipLibCheck": true, "esModuleInterop": true, "resolveJsonModule": true, "isolatedModules": true,
    "jsx": "react-jsx", "jsxImportSource": "hono/jsx"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.d.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist", "vitest.config.ts"]
}
```
`src/node-shims.d.ts`:
```ts
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> { run<R>(store: T, fn: () => R): R; getStore(): T | undefined; }
}
```

### 5.4 `vitest.config.ts` and `test/setup.ts`
```ts
// vitest.config.ts (excluded from tsc)
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, OWNER_PASSPHRASE: "test-passphrase", MCP_API_TOKEN: "test-static-token", MCP_SERVER_NAME: "homcp-test", HOMCP_SECRET_X: "s3cret" } }
    })],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] }
  };
});
```
```ts
// test/setup.ts
import { applyD1Migrations, env } from "cloudflare:test";
declare module "cloudflare:test" {
  interface ProvidedEnv { DB: D1Database; OAUTH_KV: KVNamespace; TEST_MIGRATIONS: D1Migration[]; MCP_SERVER_NAME: string; OWNER_PASSPHRASE: string; MCP_API_TOKEN: string; HOMCP_SECRET_X: string }
}
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

### 5.5 `.dev.vars.example` (identical content in `.env.example`)
```ini
# The Deploy to Cloudflare button prompts for every UNCOMMENTED line here as a required secret. Never commit real values.
# Owner passphrase: typed on the OAuth approval page (claude.ai / Claude Code connect) and the /owner console. Generate: openssl rand -base64 24
OWNER_PASSPHRASE=replace-with-a-long-random-passphrase
# Optional static bearer for headless clients (cron, CI, Codex). Keep commented so the button does not require it;
# enable later with: wrangler secret put MCP_API_TOKEN
# MCP_API_TOKEN=
```

### 5.6 `.gitignore`
```
node_modules/
dist/
.wrangler/
.dev.vars
.dev.vars.*
!.dev.vars.example
.env
.envrc
*.log
.DS_Store
env.d.ts
```

---

## 6. Data model (DDL verbatim)

### 6.1 `migrations/0001_registry.sql`
```sql
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO settings(key, value) VALUES ('catalog_version', '1');
INSERT OR IGNORE INTO settings(key, value) VALUES ('promoted_budget', '12');
-- optional keys (absent = default): identity_name, identity_title, identity_description, identity_instructions

CREATE TABLE IF NOT EXISTS tool_defs (
  name         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('template','http','mcp','compose')),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  spec         TEXT NOT NULL,
  annotations  TEXT NOT NULL DEFAULT '{}',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tool_overrides (
  scope       TEXT NOT NULL CHECK (scope IN ('deploy','client')),
  client_key  TEXT NOT NULL DEFAULT '',
  tool_name   TEXT NOT NULL,
  enabled     INTEGER CHECK (enabled IN (0,1)),
  promoted    INTEGER CHECK (promoted IN (0,1)),
  title       TEXT,
  description TEXT,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, client_key, tool_name)
);
CREATE INDEX IF NOT EXISTS tool_overrides_tool ON tool_overrides(tool_name);

CREATE TABLE IF NOT EXISTS upstreams (
  name        TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  auth_kind   TEXT NOT NULL CHECK (auth_kind IN ('none','bearer','secret')),
  auth_value  TEXT,
  headers     TEXT NOT NULL DEFAULT '{}',
  server_info TEXT,
  tool_cache  TEXT,
  cached_at   TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS registry_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS registry_events_at ON registry_events(at DESC);
```

### 6.2 `migrations/0002_memory.sql`
```sql
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','decision','lesson','context','person','project')),
  tags       TEXT NOT NULL DEFAULT '[]',
  tags_text  TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS memories_updated ON memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_importance ON memories(importance DESC, updated_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, content, tags_text,
  content='memories', content_rowid='rowid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, tags_text) VALUES (new.rowid, new.title, new.content, new.tags_text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags_text) VALUES ('delete', old.rowid, old.title, old.content, old.tags_text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags_text) VALUES ('delete', old.rowid, old.title, old.content, old.tags_text);
  INSERT INTO memories_fts(rowid, title, content, tags_text) VALUES (new.rowid, new.title, new.content, new.tags_text);
END;
```

### 6.3 KV keys and per-request access
KV (`OAUTH_KV`): provider-owned `client:*`, `grant:*`, `token:*`, `refresh:*`; ours `owner-session:<uuid>` (TTL 43200), `ratelimit:authorize:<ip>` and `ratelimit:owner-login:<ip>` (TTL 600).
Snapshot = ONE `db.batch`: `SELECT key,value FROM settings; SELECT * FROM tool_defs ORDER BY name; SELECT * FROM tool_overrides WHERE scope='deploy' OR (scope='client' AND client_key=?1); SELECT name,url,auth_kind,headers,server_info,cached_at,created_by,created_at FROM upstreams ORDER BY name` (auth_value/tool_cache never loaded into the snapshot). Every mutation = ONE `db.batch` = write(s) + `UPDATE settings SET value = CAST(value AS INTEGER)+1 WHERE key='catalog_version'` + `INSERT INTO registry_events`. D1 limits: ≤100 params, ≤100 KB statement, 30 s per batch; `define_tool` refuses beyond 200 rows (free tier 5 M rows read/day — spike hit code 7500).

---

## 7. Shared contract — `src/types.ts` (verbatim)

```ts
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
```

### 7.2 Module boundary signatures
```ts
// src/version.ts [W0]      export const VERSION: string;   // package.json version
// src/scope.ts [W0]        export const requestScope: AsyncLocalStorage<RequestScope>; export function getScope(): RequestScope; // throws outside a request
// src/mcp/result.ts [W0]   export const REFRESH_HINT: string; export function ok(text: string, structured?: Record<string, unknown>): CallToolResult;
//                          export function fail(code: ErrorCode, message: string, hint?: string, details?: unknown): CallToolResult;  // isError:true, structuredContent: ToolErrorBody
//                          export function withRefreshHint(r: CallToolResult): CallToolResult; export function truncate(text: string, max?: number): string; // 100_000 default
// src/identity.ts [A]      export const IDENTITY_NAME_RE: RegExp; export const DEFAULT_INSTRUCTIONS: (name: string) => string;
//                          export function hostLabel(host: string): string | null; export function resolveIdentity(settings: SettingsMap, env: Env, host: string): Identity;
//                          export function validateIdentityName(name: string): string | null;
// src/mcp/principal.ts [A] export const CLIENT_KEY_RE: RegExp; export function principalFromProps(props: unknown): Principal; export function labelFromClientName(clientName: string | undefined): string;
// src/mcp/handler.ts [A]   export const mcpApiHandler: { fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> }; export function notifyToolsChanged(): void;
// src/mcp/factory.ts [A]   export function buildServer(mcpCtx: McpRequestContext, scope: RequestScope): Promise<McpServer>;
// src/registry/db.ts [B]   loadSnapshot(db, clientKey): Promise<Snapshot> (throws SchemaMissingError); emptySnapshot(): Snapshot; getUpstreamFull(db, name): Promise<UpstreamRow|null>;
//                          insertDef(db, row, promote, actor); replaceDef(db, row, actor); deleteDef(db, name, actor); upsertOverride(db, scope, clientKey, toolName, patch, actor);
//                          deleteOverride(db, scope, clientKey, toolName, actor); setSettings(db, values: Record<string,string|null>, actor); insertUpstream(db, row, actor);
//                          updateUpstreamCache(db, name, serverInfo, toolCache); deleteUpstream(db, name, actor); listEvents(db, limit?); isSchemaMissing(err): boolean
// src/registry/resolve.ts [B]  export function resolveCatalog(builtins: BuiltinSpec[], snap: Snapshot, principal: Principal, identity: Identity): ResolvedCatalog;  // pure
// src/registry/names.ts [B]    export const TOOL_NAME_RE: RegExp; nameBudget(identityName): number; validateToolName(name, catalog, opts?: {replace?: boolean}); validateInputSchema(schema: unknown); validateUpstreamName(name): string|null
// src/registry/dispatch.ts [B] export const MAX_DEPTH = 3; export const MAX_HOP = 3; export function invoke(scope, catalog, name, args, opts: { depth: number }): Promise<CallToolResult>;
// src/tools/builtin/index.ts [B] export const BUILTINS: BuiltinSpec[]; export const PROTECTED: ReadonlySet<string>; export const HIDDEN_BY_DEFAULT: ReadonlySet<string>;
// src/registry/upstream.ts [C]  export const outbound: { fetch: typeof fetch }; withUpstream<T>(scope, up: UpstreamRow, fn: (c: Client) => Promise<T>, timeoutMs?): Promise<T>; redactUpstream(up)
// src/registry/kinds/index.ts [C] export const KINDS: Record<DefinedKind, KindModule>;
// src/util/template.ts [C]  RenderContext { input, steps: Record<string,{text; structured?; isError}>, identity, principal, now:{iso,date}, secret?: (name)=>string|undefined };
//                          render(template, ctx, opts?: {allowSecret?}): string; renderValue(value, ctx, opts?): unknown
// src/memory/store.ts [D]  remember(db, input, actor); recall(db, q): Promise<{rows, mode:"fts"|"like"|"recent"}>; readMemory; reviseMemory; forgetMemory; memoryStats(db)
// src/web/snippets.ts [E]  installSnippets(identity, origin): Snippets; serverInfoPayload(catalog, scope, opts:{cimd:boolean}): ServerInfoPayload
// src/web/app.tsx [A+E]    export const webApp: Hono<{ Bindings: Env }>;
```

---

## 8. Runtime architecture

```
export default { fetch }   src/worker.ts
 ├─ path == /mcp && MCP_API_TOKEN set && bearer == token (constant time) → ctx.props = {userId:"owner", via:"token", clientKey:"token"} → mcpApiHandler.fetch   [static door]
 └─ provider.fetch(request, env, ctx)   [OAuthProvider, module scope]
      ├─ OPTIONS, /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource[/mcp], /oauth/token, /oauth/register   (provider)
      ├─ /mcp* → bearer validated → ctx.props = grant props → mcpApiHandler.fetch
      └─ else → defaultHandler = webApp: GET / · /health · /api/info · /sse (410) · GET+POST /authorize · /owner/* · 404 JSON
mcpApiHandler.fetch   src/mcp/handler.ts
 └─ principal = principalFromProps(ctx.props); hop = X-Homcp-Hop; requestScope.run(scope, () => getHandler(env)(request, env, ctx))
    getHandler = lazy module singleton createMcpHandler(factory, { route:"/mcp", allowedHostnames?, onerror })
    factory(mcpCtx) = buildServer(mcpCtx, getScope()): era → loadSnapshot (SchemaMissingError → emptySnapshot) → resolveIdentity → resolveCatalog →
      new McpServer({name, version, title?}, {instructions, cacheHints}) → registerTool for every enabled tool in name order; reg.disable() when !promoted
```

### 8.1 `src/worker.ts`
```ts
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
```

### 8.2 `src/oauth/provider.ts`
```ts
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
```

### 8.3 `src/mcp/handler.ts`
```ts
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
```

### 8.4 `src/mcp/factory.ts`
```ts
import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { VERSION } from "../version";
import { resolveIdentity } from "../identity";
import { loadSnapshot, emptySnapshot } from "../registry/db";
import { resolveCatalog } from "../registry/resolve";
import { invoke } from "../registry/dispatch";
import { BUILTINS } from "../tools/builtin";
import { SchemaMissingError, type RequestScope } from "../types";
export async function buildServer(mcpCtx: McpRequestContext, scope: RequestScope): Promise<McpServer> {
  scope.era = mcpCtx.era;
  let snapshot;
  try { snapshot = await loadSnapshot(scope.env.DB, scope.principal.clientKey); }
  catch (e) { if (!(e instanceof SchemaMissingError)) throw e; console.error("registry unavailable: run `npm run db:migrate:remote`"); snapshot = emptySnapshot(); }
  const identity = resolveIdentity(snapshot.settings, scope.env, scope.host);
  const catalog = resolveCatalog(BUILTINS, snapshot, scope.principal, identity);
  const server = new McpServer(
    { name: identity.name, version: VERSION, ...(identity.title ? { title: identity.title } : {}) },
    { instructions: identity.instructions, cacheHints: { "tools/list": { ttlMs: 0, cacheScope: "private" }, "server/discover": { ttlMs: 0, cacheScope: "private" } } }
  );
  const entries = [...catalog.tools.values()].filter((t) => t.state.enabled).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const tool of entries) {
    const reg = server.registerTool(tool.name,
      { title: tool.state.title, description: tool.state.description, inputSchema: tool.inputSchema, annotations: tool.annotations, ...(tool.meta ? { _meta: tool.meta } : {}) },
      (args) => invoke(scope, catalog, tool.name, args, { depth: 0 }));
    if (!tool.state.promoted) reg.disable();   // hidden from tools/list; direct tools/call → SDK "Tool X disabled"; reachable via call_tool
  }
  return server;
}
```

### 8.5 `src/mcp/principal.ts` (core)
```ts
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
```

---

## 9. Names and the rename story (verbatim; also `docs/NAMES.md`, landing, `set_identity` result)

Three names that matter and one that does not:

| # | Name | Who sets it | Where it shows | Rule |
|---|---|---|---|---|
| 1 | **Worker name / hostname** | Deploy-button "Project name" (rewrites wrangler `name`), `wrangler.jsonc:name`, or a dashboard custom domain | the URL `https://<name>.<subdomain>.workers.dev/mcp` | Workers Builds requires dashboard name == wrangler `name` (`WRANGLER_CI_OVERRIDE_NAME`) |
| 2 | **Instance identity** (`serverInfo.name`, approval-page and landing copy, `/health`, `/api/info`, `whoami`, `server_info`) | this server. Precedence: D1 `settings.identity_name` (`set_identity` / `/owner`) → var `MCP_SERVER_NAME` when non-empty → first DNS label of the request Host (`thor-memory.buildwithoracle.com` → `thor-memory`; `localhost` skipped) → `homcp` | approval page ("Connect **Claude** to **thor-memory**"), landing, tools | `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` — exactly what `claude mcp add` accepts, so "key = identity" snippets always work |
| 3 | **Client key** | Claude Code: `claude mcp add <key>` or the `.mcp.json` key → prefix `mcp__<key>__`; claude.ai: the Name typed in "Add custom connector" (`connectorName=`); Codex: `codex mcp add <name>` | tool names in the model's context, `/mcp` panel, connectors list | every key char costs one tool-name char: `len(tool) <= 121 − len(key)`; landing suggests key = identity |
| — | `McpServer` `title` | this server (optional) | nothing today (neither client displays serverInfo.name/title, LIVE) | omitted unless set via `set_identity` |

Rules: renaming #2 never touches tool names, D1/KV names, KV prefixes, the `homcp_owner` cookie or issued tokens; the D1 setting wins over the var so a rename never needs a redeploy; the button does not persist edited `vars` and a Workers Builds redeploy re-applies `wrangler.jsonc`, so **`set_identity` is the durable rename**; `set_identity` re-checks every definition against the new name budget and lists offenders (never deletes); renaming does not rename a claude.ai connector or a Claude Code key; claude.ai refuses a URL already registered in the org; a hostname change keeps tokens valid (no audience pinning) but claude.ai treats the new URL as a new connector.

`src/identity.ts` core:
```ts
export const IDENTITY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const DEFAULT_INSTRUCTIONS = (name: string) =>
  `${name} is a higher-order MCP server: it can create, hide, show and proxy tools at runtime. ` +
  `Call list_tools to see every tool including hidden ones, describe_tool for a tool's schema, and call_tool {name, arguments} to run a tool that is not in your tool list. ` +
  `define_tool creates tools (kinds: template, http, mcp, compose) that start hidden; promote_tool lists them; toggle_tool switches tools on/off. ` +
  `Use remember/recall for notes the user wants kept. After changing tools, refresh your tool list.`;
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
```

---

## 10. Registry: layering and resolution

### 10.1 Semantics
BUILTIN (code defaults: `enabled=true`, `promoted=!hiddenByDefault`) → DEPLOY (`tool_overrides` scope=deploy; definitions enter here as `enabled=true, promoted=false`) → CLIENT (scope=client for `principal.clientKey`). `enabled=false` ⇒ not registered, not listed, `call_tool` refuses (`tool_disabled`); disable is sticky downward (a client cannot re-enable a deploy-disabled tool). `promoted=false` ⇒ registered but `disable()`d ⇒ absent from `tools/list`, direct `tools/call` → SDK "Tool X disabled", callable through `call_tool`. `promoted`: client > deploy > builtin default. `enabled = deploy ∧ (deployDisabled ? false : client ?? true)`. Deploy `title`/`description` overrides win over code/definition. PROTECTED = `list_tools, describe_tool, call_tool, toggle_tool, promote_tool, demote_tool` — always enabled+promoted; writes refused with `protected_tool`. Budget (`settings.promoted_budget`, default 12) counts promoted non-builtin tools per scope, enforced only at `promote_tool` / `define_tool {promote:true}`; over-budget states only warn in `list_tools`. Visible = enabled ∧ promoted, sorted by name; registration follows the same order.

### 10.2 `src/registry/resolve.ts` (verbatim)
```ts
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BuiltinSpec, Identity, Layer, Principal, ResolvedCatalog, ResolvedTool, Snapshot, ToolAnnotations } from "../types";
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
function fromBuiltin(b: BuiltinSpec): ResolvedTool {
  return { name: b.name, kind: "builtin", protected: !!b.protected, annotations: b.annotations, meta: b.meta,
    inputSchema: b.inputSchema, inputSchemaJson: z.toJSONSchema(b.inputSchema) as Record<string, unknown>, builtin: b,
    state: { enabled: true, promoted: !b.hiddenByDefault, title: b.title, description: b.description, decidedBy: { enabled: "builtin", promoted: "builtin" }, deployDisabled: false } };
}
function fromDef(d: Snapshot["defs"][number], warnings: string[]): ResolvedTool | null {
  try {
    const json = JSON.parse(d.input_schema) as Record<string, unknown>;
    const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...(JSON.parse(d.annotations) as Partial<ToolAnnotations>) };
    return { name: d.name, kind: d.kind, protected: false, annotations, inputSchema: fromJsonSchema(json), inputSchemaJson: json, def: d, spec: JSON.parse(d.spec),
      state: { enabled: true, promoted: false, title: d.title, description: d.description, decidedBy: { enabled: "builtin", promoted: "builtin" }, deployDisabled: false } };
  } catch (e) { warnings.push(`definition ${d.name} is unreadable and was skipped: ${String(e)}`); return null; }
}
export function resolveCatalog(builtins: BuiltinSpec[], snap: Snapshot, principal: Principal, identity: Identity): ResolvedCatalog {
  const warnings: string[] = [];
  const tools = new Map<string, ResolvedTool>();
  for (const b of builtins) tools.set(b.name, fromBuiltin(b));                                   // 1. GLOBAL
  for (const d of snap.defs) {                                                                    // 2. DEPLOY definitions (enabled, hidden)
    if (tools.has(d.name)) { warnings.push(`definition ${d.name} shadows a built-in and was ignored`); continue; }
    const t = fromDef(d, warnings); if (t) tools.set(d.name, t);
  }
  for (const scope of ["deploy", "client"] as const) {                                            // 3. overrides, deploy then client
    for (const o of snap.overrides) {
      if (o.scope !== scope) continue;
      const t = tools.get(o.tool_name); if (!t) continue;                                          // stale row ignored
      const layer: Layer = scope;
      if (o.enabled !== null && !t.protected) {
        if (scope === "deploy") { t.state.enabled = o.enabled === 1; t.state.deployDisabled = o.enabled === 0; t.state.decidedBy.enabled = layer; }
        else if (!t.state.deployDisabled) { t.state.enabled = o.enabled === 1; t.state.decidedBy.enabled = layer; }
      }
      if (o.promoted !== null && !t.protected) { t.state.promoted = o.promoted === 1; t.state.decidedBy.promoted = layer; }
      if (scope === "deploy") { if (o.title) t.state.title = o.title; if (o.description) t.state.description = o.description; }
    }
  }
  for (const t of tools.values()) if (t.protected) { t.state.enabled = true; t.state.promoted = true; t.state.deployDisabled = false; }   // 4. protected invariant
  const visible = [...tools.values()].filter((t) => t.state.enabled && t.state.promoted).sort(byName);                                // 5. deterministic
  const usedDeploy = [...tools.values()].filter((t) => t.kind !== "builtin" && t.state.promoted && t.state.decidedBy.promoted === "deploy").length;
  const usedClient = [...tools.values()].filter((t) => t.kind !== "builtin" && t.state.promoted && t.state.decidedBy.promoted === "client").length;
  if (usedDeploy > snap.promotedBudget) warnings.push(`deploy layer has ${usedDeploy} promoted definitions, budget is ${snap.promotedBudget}`);
  if (snap.schemaMissing) warnings.push("database not migrated: run `npm run db:migrate:remote`; only built-in tools are available and registry/memory tools will fail");
  return { tools, visible, budget: { limit: snap.promotedBudget, usedDeploy, usedClient }, identity, principal, catalogVersion: snap.catalogVersion, upstreams: snap.upstreams, schemaMissing: snap.schemaMissing, warnings };
}
```

### 10.3 Names (`src/registry/names.ts` core)
```ts
export const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;      // no '.', Claude Code sanitizes it to '_'
export function nameBudget(identityName: string): number { return Math.min(64, 121 - identityName.length); }
const RESERVED = new Set(["mcp", "tools", "call", "list"]);
export function validateToolName(name, catalog, opts = {}) {
  if (!TOOL_NAME_RE.test(name)) return { code: "invalid_name", message: `'${name}' is not a valid tool name.`, hint: "Start with a letter; letters, digits, '_' or '-'; max 64 chars; no dots." };
  if (name.startsWith("mcp__") || RESERVED.has(name)) return { code: "invalid_name", message: `'${name}' is reserved.` };
  const budget = nameBudget(catalog.identity.name);
  if (name.length > budget) return { code: "name_too_long", message: `'${name}' is ${name.length} chars; budget for identity '${catalog.identity.name}' is ${budget}.`, hint: "mcp__<key>__<tool> must stay <= 128 characters or the Claude API rejects every request that includes it." };
  const existing = catalog.tools.get(name);
  if (existing && (existing.kind === "builtin" || !opts.replace)) return { code: "name_taken", message: `'${name}' is already ${existing.kind === "builtin" ? "a built-in tool" : `a ${existing.kind} tool`}.`, hint: existing.kind === "builtin" ? "Pick another name." : "Pass replace:true to update it in place." };
  return null;
}
// validateInputSchema: JSON object with type:"object"; no anyOf/oneOf/allOf/$ref at root; property names /^[A-Za-z0-9_.-]{1,64}$/; serialized <= 8192 bytes; depth <= 4; fromJsonSchema(schema)['~standard'].validate({}) must not throw.
```

---

## 11. Tool catalog (verbatim)

Every tool: `title`, `description` ≤ 400 chars, `inputSchema: z.object(...)` (`z.object({})` when no args), all four hints, `structuredContent` next to text. `_meta["anthropic/alwaysLoad"]: true` on `list_tools`, `describe_tool`, `call_tool`; `_meta["anthropic/requiresUserInteraction"]: true` on `remove_tool`, `remove_upstream`, `forget_memory`. RO/D/I/OW = readOnly/destructive/idempotent/openWorld hints; P = PROTECTED.

| Tool | Layer / flags | RO | D | I | OW | Input (`z.object` fields) | Behaviour and result |
|---|---|---|---|---|---|---|---|
| `list_tools` | builtin, P, listed, alwaysLoad | ✓ | – | ✓ | – | `include_hidden?: boolean = true`, `only?: enum(builtin,defined,visible,hidden,disabled)` | Text table name · kind · title · enabled · promoted · visible · protected · decidedBy · full-name length; footer `visible N · budget usedDeploy/limit (+usedClient client) · defined N · upstreams N · catalog_version V · identity NAME`; warnings; refresh hint. `structuredContent: { tools:[{name,kind,title,enabled,promoted,visible,protected,decidedBy,origin}], budget, catalogVersion, identity, warnings }` |
| `describe_tool` | builtin, P, listed, alwaysLoad | ✓ | – | ✓ | – | `name: string` | name, kind, title, description, `inputSchema` (JSON Schema), annotations, `_meta`, matching override rows per layer, spec with secrets redacted (`{{secret:X}}` kept, bearer `•••`), mcp: cached upstream tool entry, compose: step graph, `created_by/at`, `version`, `claudeCodeName: mcp__<identity>__<name>` + length |
| `call_tool` | builtin, P, listed, alwaysLoad | – | – | – | ✓ | `name: string`, `arguments?: record = {}` | `invoke(name, arguments, depth 0)`: reaches hidden tools; refuses disabled (`tool_disabled`), unknown (`unknown_tool` + nearest names), itself. Returns the target's result verbatim |
| `define_tool` | builtin, listed | – | – | – | – | `name`, `kind: enum(template,http,mcp,compose)`, `title?: ≤80`, `description: 1..1500`, `input_schema?: record`, `spec: record`, `annotations?: partial hints`, `promote?: boolean=false`, `replace?: boolean=false` | §12. Text: "Defined `X` (kind). Callable now via call_tool {name:"X"}. Not listed until promote_tool." + refresh hint. `structuredContent: { name, kind, visible, claudeCodeName, warnings }` |
| `toggle_tool` | builtin, P, listed | – | – | ✓ | – | `name`, `enabled?: boolean` (omit = flip), `scope?: enum(deploy,client)="deploy"`, `client?: string` | Protected → `protected_tool`. Upserts `tool_overrides.enabled`; client `enabled:true` clears the client row (cannot undo a deploy disable). Notifies. Text states effective state + deciding layer + refresh hint |
| `promote_tool` | builtin, P, listed | – | – | ✓ | – | `name`, `scope?`, `client?` | Requires enabled; non-builtins count promoted definitions at that scope, ≥ budget → `slot_budget_exceeded` listing them. Upserts `promoted=1`, notifies. "Promoted `X` (visible N of budget B)." + refresh hint |
| `demote_tool` | builtin, P, listed | – | – | ✓ | – | `name`, `scope?`, `client?` | Protected → `protected_tool`. `promoted=0` (built-ins allowed; still callable via `call_tool`). Notifies + hint |
| `remove_tool` | builtin, hidden, requiresUserInteraction | – | ✓ | ✓ | – | `name`, `confirm: literal(true)` | Definitions only (`not_a_definition` for built-ins). Deletes row + every override. Notifies |
| `override_tool` | builtin, hidden | – | – | ✓ | – | `name`, `title?: ≤80`, `description?: ≤1500`, `reset?: boolean` | Deploy-scope title/description override of any tool (`reset` clears). Notifies |
| `whoami` | builtin, listed | ✓ | – | ✓ | – | `{}` | Principal (`via`, `clientKey`, `clientId`, `clientName`, `scopes`), `era`, `host`, identity, hop, count of client overrides |
| `server_info` | builtin, listed | ✓ | – | ✓ | – | `{}` | `ServerInfoPayload` (same as `/api/info`) incl. snippets + refresh hint |
| `set_identity` | builtin, hidden | – | – | ✓ | – | `name?`, `title?: ≤80`, `description?: ≤300`, `instructions?: ≤1000`, `reset?: boolean` | Validates `IDENTITY_NAME_RE`; writes/clears settings; returns the three-names explainer, new budget, definitions now over budget. Notifies |
| `add_upstream` | builtin, hidden | – | – | ✓ | ✓ | `name` (`^[a-z][a-z0-9_-]{0,31}$`), `url` (https), `auth?: { kind: enum(none,bearer,secret), value?: string }`, `headers?: record(string)` | Connects once (`withUpstream` → `listTools`), stores row + `server_info` + `tool_cache`; lists tool names + a ready `define_tool {kind:"mcp"}` example; secrets never echoed; `bearer` flagged plaintext |
| `remove_upstream` | builtin, hidden, requiresUserInteraction | – | ✓ | ✓ | – | `name`, `force?: boolean=false` | `upstream_in_use` while mcp definitions reference it unless `force` (deletes them too). Notifies |
| `list_upstreams` | builtin, hidden | ✓ | – | ✓ | – | `{}` | Redacted rows: `auth_kind`, cached tool count, `cached_at`, referencing definitions |
| `upstream_tools` | builtin, hidden | ✓ | – | ✓ | ✓ | `upstream`, `refresh?: boolean=false`, `filter?: string` | Cached list or live `listTools` (updates cache). Never registers anything |
| `remember` | builtin, listed | – | – | – | – | `content: 1..12000`, `title?: ≤160` (default first line), `kind?: enum(note,decision,lesson,context,person,project)="note"`, `tags?: string[]≤10`, `importance?: int 1..5=3` | Insert; `created_by = clientKey`; returns id + summary |
| `recall` | builtin, listed | ✓ | – | ✓ | – | `query?: ≤240`, `kind?`, `tag?`, `limit?: 1..50=10` | FTS5 `MATCH` by `bm25`; MATCH error → `LIKE` (memoised per isolate); empty query → recent by importance. `structuredContent: { mode, memories }` |
| `read_memory` | builtin, listed | ✓ | – | ✓ | – | `id: uuid` | One memory or `not_found` |
| `revise_memory` | builtin, listed | – | – | ✓ | – | `id`, `title?`, `content?`, `kind?`, `tags?`, `importance?` (≥1) | Updates, keeps id/created_at |
| `forget_memory` | builtin, listed, requiresUserInteraction | – | ✓ | ✓ | – | `id: uuid` | Deletes; `not_found` when missing |
| `memory_stats` | builtin, listed | ✓ | – | ✓ | – | `{}` | Totals by kind, top tags, latest update, `fts: on|off` |
| *defined `template`* | deploy, hidden until promoted | ✓ | – | ✓ | – | caller `input_schema` | Renders `spec.text`; `format:"json"` also parses into `structuredContent` |
| *defined `http`* | deploy | GET | DELETE/PUT/PATCH | ≠POST | ✓ | caller | one https request, host allow-list, caps (§12.3) |
| *defined `mcp`* | deploy | from upstream | from upstream | from upstream | ✓ | upstream snapshot minus bound keys (or caller) | per-request client call of one upstream tool |
| *defined `compose`* | deploy | AND steps | OR steps | AND steps | OR steps | caller | sequential steps with arg mapping |

22 built-ins: 15 listed by default (`list_tools, describe_tool, call_tool, define_tool, toggle_tool, promote_tool, demote_tool, whoami, server_info, remember, recall, read_memory, revise_memory, forget_memory, memory_stats`); 7 hidden (`override_tool, remove_tool, add_upstream, remove_upstream, list_upstreams, upstream_tools, set_identity`).

---

## 12. `define_tool`: schema, kinds, template language, executors

### 12.1 Input (`src/mcp/schemas.ts`)
```ts
import { z } from "zod";
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
```
`define_tool` algorithm: parse → `validateToolName` (with `replace`) → `validateInputSchema` → `KINDS[kind].specSchema.parse` (`spec_invalid`) → `KINDS[kind].validate` (may fill schema/title/description/annotations) → `annotations = {...defaultAnnotations, ...validation.annotations, ...input.annotations}` → budget check if `promote` → `insertDef`/`replaceDef` (one batch with version bump + event) → `notifyToolsChanged()` → result + refresh hint. Refuses beyond 200 definitions.

### 12.2 Template language (`src/util/template.ts`)
`{{expr}}` → stringified (missing → "" + warning in `_meta.homcp.warnings`); `{{json expr}}` → JSON; a whole-string `{{= expr}}` inside args/body/bind → raw typed value; `{{secret:NAME}}` → `env["HOMCP_SECRET_"+NAME]` (`^[A-Z][A-Z0-9_]*$`), only where `allowSecret` (http url/headers), never echoed. `expr` roots: `input.<key>[.path]`, `steps.<id>.text|structured[.path]|isError`, `principal.clientKey`, `identity.name`, `now.iso|date`; path segments `a.b[0].c`. Unknown root → `spec_invalid` at define time (dry render with `{}`).

### 12.3 Kinds
**template**: render `text`; `format:"json"` parses → `structuredContent`. Defaults `{RO:true,D:false,I:true,OW:false}`.
**http** define-time: `https://` only; host is a DNS name (reject literal IPv4/IPv6, `localhost`, `*.localhost`, `*.internal`, `*.local`, `*.home.arpa`); no `{{` in the host part; `allowed_hosts` defaults to `[url host]`; every `{{secret:NAME}}` must resolve; dry-render. Runtime: render url/headers/body; re-check https + host ∈ `allowed_hosts` (`http_blocked_host`); `outbound.fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(timeout_ms) })`; read ≤ `max_bytes` then abort (`http_too_large` note); non-2xx → `http_failed {status}` + first 2 KB; `json`/`auto` parses → `structuredContent` (optionally `json_path`); timeout → `http_timeout`. Defaults `{RO: GET, D: DELETE/PUT/PATCH, I: ≠POST, OW:true}`.
**mcp** define-time: upstream exists (`unknown_upstream`); `withUpstream(listTools)` succeeds (`upstream_unreachable`) and contains `tool` (`upstream_tool_missing`); `schema:"snapshot"` → upstream `inputSchema` minus bound keys becomes `input_schema` unless supplied; upstream title/description/annotations default; refreshes `tool_cache`. Runtime: `args = {...input, ...renderValue(bind)}` → `withUpstream(scope, up, c => c.callTool({ name: spec.tool, arguments: args }, { timeout: spec.timeout_ms }))` → passthrough content/structuredContent/isError (text prefixed `upstream <name>: `), `_meta.homcp.upstream`. Defaults: upstream annotations else `{RO:false,D:false,I:false,OW:true}`.
**compose** define-time: unique ids; each `step.tool` exists (hidden ok, disabled → `tool_disabled`); no self-reference; compose→compose allowed (depth guard). Runtime: sequential `invoke(step.tool, renderValue(step.args, {input, steps}), depth+1)`; `steps[id] = {text, structured, isError}`; `on_error:"stop"` → `compose_step_failed {step}` with partial steps in details; `"continue"` proceeds. Output `last` (last content + `structuredContent {steps,last}`) or `all` (section per step). Wall budget ≤ 45 s. Defaults `{RO: all RO, D: any D, I: all I, OW: any OW}`.

### 12.4 Upstream client (`src/registry/upstream.ts`)
```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { VERSION } from "../version";
import type { RequestScope, UpstreamRow } from "../types";
export const outbound = { fetch: globalThis.fetch.bind(globalThis) as typeof fetch };   // tests: outbound.fetch = (i, init) => SELF.fetch(i, init)
export function upstreamHeaders(up: UpstreamRow, scope: RequestScope): Headers {
  const h = new Headers(JSON.parse(up.headers || "{}"));
  const token = up.auth_kind === "bearer" ? up.auth_value : up.auth_kind === "secret" && up.auth_value ? scope.env[`HOMCP_SECRET_${up.auth_value}`] : undefined;
  if (token) h.set("authorization", `Bearer ${token}`);
  h.set("x-homcp-hop", String(scope.hop + 1));
  return h;
}
export async function withUpstream<T>(scope: RequestScope, up: UpstreamRow, fn: (c: Client) => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("upstream_timeout")), timeoutMs + 10_000);
  const transport = new StreamableHTTPClientTransport(new URL(up.url), { requestInit: { headers: upstreamHeaders(up, scope), signal: ac.signal }, fetch: outbound.fetch });
  const client = new Client({ name: "homcp", version: VERSION }, { capabilities: {}, versionNegotiation: { mode: "auto" } });   // server/discover first, legacy fallback
  try { await client.connect(transport, { timeout: 10_000 }); return await fn(client); }
  finally { clearTimeout(timer); await client.close().catch(() => {}); }
}
```
One `Client` per call, never cached. **Hop guard**: `X-Homcp-Hop = scope.hop + 1` on every upstream request; parsed at the `/mcp` entry; `invoke()` refuses every call when `scope.hop >= MAX_HOP (3)` with `hop_limit`.

### 12.5 Dispatcher (`src/registry/dispatch.ts`)
```ts
export const MAX_DEPTH = 3; export const MAX_HOP = 3;
export async function invoke(scope, catalog, name, rawArgs, opts) {
  const t = catalog.tools.get(name);
  if (!t) return fail("unknown_tool", `No tool named '${name}'.`, `Nearest: ${nearest(name, catalog)}. Call list_tools to see every tool, including hidden ones.`);
  if (name === "call_tool" && opts.depth > 0) return fail("depth_exceeded", "call_tool cannot call itself.");
  if (!t.state.enabled) return fail("tool_disabled", `'${name}' is switched off (${t.state.decidedBy.enabled} layer).`, t.state.deployDisabled ? "The deploy layer disabled it; only toggle_tool at scope 'deploy' (or the owner console) can re-enable it." : "toggle_tool {name, enabled:true} re-enables it.");
  if (opts.depth > MAX_DEPTH) return fail("depth_exceeded", `Nesting deeper than ${MAX_DEPTH}.`);
  if (scope.hop >= MAX_HOP) return fail("hop_limit", `This call already crossed ${MAX_HOP} homcp deployments.`, "A definition is probably proxying itself through an upstream; check list_upstreams.");
  if (catalog.schemaMissing && t.kind !== "builtin") return fail("db_not_migrated", "The registry database is not migrated.", "Run `npm run db:migrate:remote`.");
  const parsed = await t.inputSchema["~standard"].validate(rawArgs ?? {});
  if (parsed.issues) return fail("invalid_arguments", formatIssues(parsed.issues), "describe_tool shows the schema.");
  const exec = { scope, catalog, depth: opts.depth };
  try {
    if (t.kind === "builtin") return await t.builtin!.handler(parsed.value as Record<string, unknown>, exec);
    return await KINDS[t.kind].run(t, parsed.value as Record<string, unknown>, exec);
  } catch (e) { console.error("tool_failed", name, t.kind, String(e)); return fail("internal", "The tool failed unexpectedly.", undefined, { kind: t.kind }); }
}
```
Error contract: `{ isError: true, content: [{ type: "text", text: "<code>: <message>\n<hint>" }], structuredContent: { error: { code, message, hint?, details? } } }`. Tools never throw.

---

## 13. Consent, owner console, rate limits

**GET /authorize**: `parseAuthRequest` (AuthorizationError with `redirectUri` → 302 with `error`,`error_description`,`state`,`iss`; else 400); require `codeChallengeMethod === "S256"` and a 43-char challenge; `lookupClient` (CIMD fetch; failure → 502 "could not fetch client metadata; retry"); render "Connect **{clientName}** to **{identity.name}**", redirect host, scopes, `label` input (default `labelFromClientName`, pattern `CLIENT_KEY_RE`), `passphrase`, hidden `state = base64url(JSON.stringify(authRequest))`, Approve/Deny. Headers `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'` (no `form-action`), `cache-control: no-store`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`. No D1 besides identity.
**POST /authorize**: KV rate limit (≥10 failures/10 min → 429); 503 when `OWNER_PASSPHRASE` unset; constant-time compare (SHA-256 + `timingSafeEqual`) else 403; re-parse `state` **through the provider** by rebuilding `/authorize?response_type&client_id&redirect_uri&scope&state&code_challenge&code_challenge_method&resource` and calling `parseAuthRequest(new Request(url))` → tampered `redirect_uri` → 400; `deny` → 302 `error=access_denied&state&iss`; `completeAuthorization({ request, userId:"owner", metadata:{ label, clientName, clientId, redirectUri, createdAt }, scope: request.scope, props:{ userId:"owner", via:"oauth", clientKey: label, clientId, clientName, scopes: request.scope, grantedAt } })` → 302 `redirectTo` (default `revokeExistingGrants` stays on: CIMD-scoped per redirect URI); event `consent.approve|deny` (ignore SchemaMissingError).
**Owner console** `/owner`: `POST /owner/login` (rate-limited) → cookie `homcp_owner=<issuedAt>.<uuid>.<hmac-sha256(issuedAt.uuid, OWNER_PASSPHRASE)>` (`HttpOnly; Secure; SameSite=Strict; Path=/owner; Max-Age=43200`) + KV `owner-session:<uuid>`; every POST needs cookie + same-origin (`Sec-Fetch-Site: same-origin` or `Origin === origin`). Tabs: Identity, Tools (deploy view with enable/disable/promote/demote/remove; budget bar), Upstreams, Connections (`listUserGrants("owner")` + Revoke), Log (last 100 events), Export (redacted). Mutations use `registry/db.ts` with `actor = "owner-console"` and `notifyToolsChanged()`.

---

## 14. listChanged, caching, ordering
Advertise `tools.listChanged:true` (SDK default) and send `notifyToolsChanged()` after `define_tool`, `toggle_tool`, `promote_tool`, `demote_tool`, `remove_tool`, `override_tool`, `set_identity`, `remove_upstream --force`, owner mutations. Isolate-local; legacy clients never receive it; Claude Code re-fetches on notification and throttles reopened streams (`/mcp` reconnect documented).
`REFRESH_HINT` (verbatim): `Clients cache the tool list. Claude Code: run /mcp and reconnect this server (or wait for the list_changed stream). claude.ai: connector menu → "Refresh tools list", then start a new chat. list_tools always shows the current catalog and call_tool can run any enabled tool without a refresh.`
`catalog_version` in `list_tools`, `server_info`, `/api/info`, `/health`. `tools/list`+`server/discover` `ttlMs:0, cacheScope:"private"`. Name-ordered registration ⇒ deterministic list. Text results truncated at 100 000 chars.

---

## 15. Web surfaces

| Route | Auth | Behaviour |
|---|---|---|
| `GET /` | public | landing (§15.2); `data-testid` on every snippet; no secrets |
| `GET /health` | public | `{ ok, name, version, schema:"ok"|"missing", catalogVersion, oauth:{ cimd, dcr:true }, tools:{ visible, total } }` |
| `GET /api/info` | public | `ServerInfoPayload` |
| `GET /sse` | public | 410 `application/problem+json` `{type:"about:blank", title:"SSE transport retired", detail:"Use Streamable HTTP at /mcp"}` + `Link: </mcp>; rel="alternate"` |
| `GET|POST /authorize` | passphrase | §13 |
| `/owner` routes | cookie + same-origin | §13 |
| other | – | 404 JSON `{error:"not_found"}` |
| `GET|DELETE /mcp` | provider→agents | 405 (legacy lane) |
CIMD status: `("compatibilityFlags" in Cloudflare) ? Cloudflare.compatibilityFlags.global_fetch_strictly_public === true : true`.

### 15.2 Landing page copy (`{name}`=identity, `{origin}`, `{key}`=identity)
```
<h1>{name}</h1>  higher-order MCP server · v{VERSION}
[pill] OAuth: CIMD + DCR  [pill] Tools: {visible} listed · {defined} defined · budget {used}/{limit}  [link] Owner console → /owner
{yellow box if schema missing: "Database not migrated yet — run `npm run db:migrate:remote`. Only built-in tools are available."}

## 1. Connect Claude Code (user scope — every project on this machine)
  claude mcp add --transport http --scope user {key} {origin}/mcp          [data-testid=claude-add]
  claude mcp login {key}                                                     [data-testid=claude-login]
  "{key}" becomes the tool prefix mcp__{key}__… — pick any short key. Later, run /mcp inside Claude Code to reconnect or refresh tools.

## 2. Connect claude.ai
  [button] Add to claude.ai → https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName={key}&connectorUrl={enc(origin)}%2Fmcp   [data-testid=claudeai-link]
  Manual: Settings → Connectors → Add → Add custom connector → Name {key}, URL {origin}/mcp → step 2 keeps "Always required" and "Use Anthropic hosted client metadata (CIMD)" (auto-detected) → Add → Connect → owner passphrase → Approve.
  Note: claude.ai refuses a URL that is already a connector in your organisation — remove the old one first.

## 3. Codex
  codex mcp add {key} --url {origin}/mcp && codex mcp login {key}            [data-testid=codex-add]

<details> Override in one project
  { "mcpServers": { "{key}": { "type": "http", "url": "${HOMCP_URL:-{origin}/mcp}" } } }      [data-testid=project-mcp-json]
  Same key as your user-scope entry — project scope wins; the tool prefix stays mcp__{key}__. Claude Code will warn "same name in more than one scope with different endpoints" — expected; sign in once per endpoint.

<details> Headless / static token (optional)
  wrangler secret put MCP_API_TOKEN, then:
  claude mcp add --transport http --scope user {key}-token {origin}/mcp --header "Authorization: Bearer $HOMCP_TOKEN"   [data-testid=claude-token]
  Never paste the token into chats; whoami reports via:"token" so transcripts can be audited.

<details> Plugin install
  /plugin marketplace add Soul-Brews-Studio/higher-order-mcp
  /plugin install homcp@homcp --config server_url={origin}/mcp                                 [data-testid=plugin-install]
  (tools appear as mcp__plugin_homcp_homcp__… — prefer the user-scope key for a short prefix or a per-project override)

<details> Rename this server — the three-names table (§9) + "ask Claude: set_identity {name:\"odin-memory\"} — or use the owner console. Client keys and connector names keep whatever you typed."
<details> Endpoints — /mcp · /.well-known/oauth-protected-resource/mcp · /.well-known/oauth-authorization-server · /authorize · /oauth/token · /oauth/register · /api/info · /health · /owner
Footer: "Tools that create tools: define_tool → call_tool → promote_tool. {REFRESH_HINT}"
```

---

## 16. Install surfaces and scripts (verbatim)

### 16.1 README.md skeleton
```markdown
# homcp — a higher-order MCP server you can rename, on Cloudflare, in one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Soul-Brews-Studio/higher-order-mcp)

One Worker that speaks MCP (2026-07-28 + the 2025 lane claude.ai still uses), does OAuth for claude.ai and Claude Code, remembers things, and can **create, hide, show and proxy tools at runtime**. Deploy it as `thor-memory`, `odin-memory`, or whatever you like.

## What you get
- OAuth 2.1 (CIMD + DCR, PKCE S256) so claude.ai and Claude Code connect with your owner passphrase; optional static token for scripts
- Memory: `remember`, `recall`, `read_memory`, `revise_memory`, `forget_memory`, `memory_stats`
- Tools that make tools: `define_tool` (template · http · mcp proxy · compose) → `call_tool` → `promote_tool`
- Three layers of control: built-ins → per-deploy overrides → per-connection overrides
- Stateless per-request server; registry in D1; no Durable Objects; deploy = `wrangler deploy`

## Deploy in ten minutes
1. Click the button. Setup page: **Project name** = Worker name (name #1, the hostname); D1 "Create new"; `OWNER_PASSPHRASE` (`openssl rand -base64 24`); `MCP_SERVER_NAME` e.g. `thor-memory` (name #2, optional — hostname label when empty).
2. Wait for the build (`npm run deploy` = `wrangler deploy` + D1 migrations). Open `https://<worker>.<you>.workers.dev/`.
3. Copy the two Claude Code lines and click **Add to claude.ai**. Both ask for your passphrase once.

## Connect
### Claude Code (user scope = every project)
    claude mcp add --transport http --scope user thor-memory https://YOUR-WORKER/mcp
    claude mcp login thor-memory
### claude.ai
    https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=thor-memory&connectorUrl=https%3A%2F%2FYOUR-WORKER%2Fmcp
    (step 2: keep "Always required" + "Use Anthropic hosted client metadata (CIMD)")
### Codex
    codex mcp add thor-memory --url https://YOUR-WORKER/mcp && codex mcp login thor-memory
### Or: scripts/connect-mcp.sh claude|codex|project https://YOUR-WORKER/mcp [key]

## Override per project
Same key in a repo's `.mcp.json` shadows the user-scope entry (precedence local > project > user > plugin > claude.ai; entries not merged):
    { "mcpServers": { "thor-memory": { "type": "http", "url": "${HOMCP_URL:-https://odin-memory.example.workers.dev/mcp}" } } }
Claude Code warns "same name in more than one scope" — expected. `scripts/connect-mcp.sh project <url> thor-memory` writes this file.

## Create your first tool
    "Define a tool called standup that returns my standup template with a project argument, then promote it."
Claude calls `define_tool` (hidden, callable via `call_tool`) then `promote_tool`. Refresh: Claude Code `/mcp` → reconnect; claude.ai connector menu → Refresh tools list → new chat.

## Rename — the three names (Worker/hostname · instance identity · client key), docs/NAMES.md. `set_identity {name:"odin-memory"}` renames without redeploying.
## Static token (optional) — `wrangler secret put MCP_API_TOKEN`, then `claude mcp add --transport http --scope user thor-memory-token https://YOUR-WORKER/mcp --header "Authorization: Bearer $HOMCP_TOKEN"`
## Local development — `npm install && cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev`; `npm run check`; `npm run deploy`
## How it works · Limits & security · Operations — docs/HIGHER_ORDER.md, docs/OPERATIONS.md, docs/CLAUDE_CODE.md, docs/CLAUDE_AI.md, docs/CODEX.md
```

### 16.2 `scripts/deploy.mjs`
```js
#!/usr/bin/env node
// Deploy = `wrangler deploy` (auto-provisions OAUTH_KV / DB from id-less bindings, linked by binding name)
//        + `wrangler d1 migrations apply DB --remote` (by BINDING). Deploy first: a fresh checkout has no database until deploy provisions it.
// The Worker tolerates the seconds in between (built-in tools only, /health schema:"missing"). No name assertions: renaming must never fail here.
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const passthrough = args.filter((a) => a !== "--dry-run");
function wrangler(cmd) {
  const r = spawnSync("npx", ["wrangler", ...cmd], { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  if (r.error) { console.error(`[deploy] could not start wrangler: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (dryRun) { console.log("[deploy] dry run (no migrations)"); wrangler(["deploy", "--dry-run", ...passthrough]); process.exit(0); }
console.log("[deploy] 1/2 wrangler deploy");
wrangler(["deploy", ...passthrough]);
console.log("[deploy] 2/2 wrangler d1 migrations apply DB --remote");
wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
console.log("\n[deploy] done. Open your Worker URL: the landing page prints the exact `claude mcp add` / claude.ai steps for this deploy.");
console.log("[deploy] note: wrangler may write resource ids into wrangler.jsonc on an interactive first deploy — keep them out of the template repo.");
```

### 16.3 `scripts/connect-mcp.sh`
```sh
#!/usr/bin/env sh
set -eu
usage() { cat <<'USAGE'
Usage: scripts/connect-mcp.sh <claude|codex|project> <https://HOST/mcp> [key]
  claude   register at Claude Code USER scope (every project) and start OAuth
  codex    register in Codex and start OAuth
  project  write ./.mcp.json with the same key so this project overrides the user-scope entry
key defaults to the first DNS label of HOST (thor-memory.example.com -> thor-memory). Never pass tokens here.
USAGE
}
[ "${1:-}" = "--help" ] && { usage; exit 0; }
[ "$#" -lt 2 ] || [ "$#" -gt 3 ] && { usage; exit 64; }
client=$1; url=$2
case "$url" in https://*/mcp) ;; *) echo "MCP URL must be https://<host>/mcp" >&2; exit 64 ;; esac
host=${url#https://}; host=${host%%/*}; key=${3:-${host%%.*}}
case "$key" in *[!A-Za-z0-9_-]*|"") echo "key may contain only letters, digits, - and _" >&2; exit 64 ;; esac
case "$client" in
  claude)
    claude mcp add --transport http --scope user "$key" "$url"
    claude mcp login "$key"
    printf '\nInstalled as user-scope server "%s" (tools appear as mcp__%s__*). Run /mcp inside Claude Code to reconnect or refresh tools.\n' "$key" "$key" ;;
  codex)
    codex mcp add "$key" --url "$url"
    codex mcp login "$key" ;;
  project)
    printf '{\n  "mcpServers": {\n    "%s": { "type": "http", "url": "${HOMCP_URL:-%s}" }\n  }\n}\n' "$key" "$url" > .mcp.json
    printf 'Wrote ./.mcp.json - project scope wins over user scope for key "%s". Claude Code will warn about the same name in two scopes; that is expected.\n' "$key" ;;
  *) usage; exit 64 ;;
esac
```

### 16.4 Plugin and marketplace
```json
// plugin/.claude-plugin/plugin.json
{ "name": "homcp", "version": "0.1.0",
  "description": "Connect a deployed homcp server (higher-order MCP on Cloudflare) to Claude Code. Tools appear as mcp__plugin_homcp_homcp__<tool>.",
  "author": { "name": "Soul Brews Studio" },
  "userConfig": { "server_url": { "type": "string", "title": "homcp server URL", "description": "Your deployment's MCP endpoint, e.g. https://thor-memory.example.workers.dev/mcp", "required": true } } }
// plugin/.mcp.json
{ "mcpServers": { "homcp": { "type": "http", "url": "${user_config.server_url}" } } }
// .claude-plugin/marketplace.json (repo root)
{ "name": "homcp", "owner": { "name": "Soul Brews Studio" }, "plugins": [ { "name": "homcp", "source": "./plugin", "description": "Connect a homcp deployment to Claude Code" } ] }
```
`examples/project.mcp.json`: `{ "mcpServers": { "thor-memory": { "type": "http", "url": "${HOMCP_URL:-https://odin-memory.example.workers.dev/mcp}" } } }`.

### 16.5 `scripts/check-names.mjs`
Node script, first in `npm run check`: scans `src/**` for the case-insensitive literals `arra`, `thor-memory`, `odin-memory`, `buildwithoracle`, `laris.workers.dev`; any hit fails with file:line (product name `homcp` is allowed; deployment names never appear in source — T shipped ~40 baked-in sites).

---

## 17. Deploy story
1. Button: setup page (project name, D1 create, `OWNER_PASSPHRASE`, `MCP_SERVER_NAME`, deploy command auto-detected `npm run deploy`) → clone, provision KV+D1, rewrite `name`/ids, run `npm run deploy`.
2. Checkout: `npm install && npm run deploy` (first deploy provisions; may write ids locally — do not commit). `npm run db:migrate:local && npm run dev` locally.
3. Verify: `curl -s https://<worker>/.well-known/oauth-authorization-server | jq .client_id_metadata_document_supported` → `true`; `curl -s https://<worker>/health` → `"schema":"ok"`.
4. Custom domain: add in the dashboard; identity falls back to the host label; optionally `ALLOWED_HOSTNAMES`.
5. Rename later: `set_identity` or `/owner`, no redeploy.
6. Blips: edge 1042 for seconds after deploy; claude.ai ~5 min discovery cache; D1 free tier 5 M rows read/day (spike hit 7500).

---

## 18. Test plan (vitest + pool-workers; every request through `SELF.fetch("https://homcp.test/...")`)
`test/helpers.ts`: `mcp(body, {token?, headers?, method?})` (Accept both types); `readJsonRpc(res)` (JSON or first SSE `data:`); `legacyInit(version)`; `modern(method, params)` adds `Mcp-Protocol-Version: 2026-07-28`, `Mcp-Method`, `params._meta = {"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}`; `callTool(name, args, token)`; `oauthDance({label, port})` (DCR `token_endpoint_auth_method:"none"` + loopback redirect → GET/POST `/authorize` → `/oauth/token` with S256); `ownerLogin()`.

| File | Locks |
|---|---|
| `stateless.test.ts` | two legacy `initialize` POSTs (2025-06-18, 2025-11-25) → 200, no `mcp-session-id`, echoed `protocolVersion`, `serverInfo.name==="homcp-test"`, version == package.json; `tools/list` without session → the 15 default names sorted; GET/DELETE `/mcp` → 405; `/mcp/other` → 404; modern `server/discover` → 200 with `tools.listChanged===true`; modern `tools/list` has `ttlMs:0`, `cacheScope:"private"` |
| `auth.test.ts` | no bearer → 401 + `WWW-Authenticate` containing `resource_metadata="https://homcp.test/.well-known/oauth-protected-resource/mcp"`; garbage bearer → 401 `invalid_token`; passphrase as bearer → 401; PRM root and `/mcp` `resource==="https://homcp.test/mcp"`, `authorization_servers[0]==="https://homcp.test"`; AS metadata: `client_id_metadata_document_supported===true`, `"none"` in auth methods, `["S256"]`, `registration_endpoint`, `authorization_response_iss_parameter_supported===true`; static token → `whoami.via==="token"`, `clientKey==="token"` |
| `consent.test.ts` | DCR 201; GET `/authorize` 200, exact CSP (no `form-action`), default label `claude-code` for `client_name:"Claude Code"`; plain PKCE → 400; wrong passphrase 403 and 429 after 10; tampered `redirect_uri` in `state` → 400; deny → 302 `error=access_denied` + `iss=https://homcp.test`; approve → 302 with `code`; token → `whoami.via==="oauth"`, `clientKey===label`; refresh rotates; second dance with label `claude` → second principal |
| `identity.test.ts` | `resolveIdentity` precedence settings > non-empty var > host > `homcp`; `hostLabel` cases; `validateIdentityName` rejects `Thor Memory`, `a.b`, 33 chars; `set_identity {name:"thor-memory"}` → next `initialize` reports it and `/` contains the exact `claude mcp add` line; `catalog_version` incremented |
| `names.test.ts` | regex (dot, leading digit, 65 chars rejected; `a-b_c` ok), `nameBudget("thor-memory")===64`, reserved `mcp__x`, builtin collision, replace semantics; `validateInputSchema` rejects root non-object, root `anyOf`, `bad name!`, 9 KB, depth 5; good schema compiles |
| `resolve.test.ts` | precedence table: defaults (15 visible/7 hidden); deploy disable; client cannot re-enable deploy-disabled; client can disable/restore own; protected immune; promoted client > deploy > default; definitions hidden by default; deploy title override; sorted `visible`; budget counts + over-budget warning; `schemaMissing` warning; determinism |
| `registry.test.ts` | define template (hidden) → absent from `tools/list`, `call_tool` works, direct `tools/call` error contains `disabled`; promote → present; demote → absent; toggle flip; `toggle_tool list_tools` → `protected_tool`; deploy-disable `remember` → hidden + `tool_disabled` for both principals; client-scope disable for the OAuth label only → token principal still sees it; client promote → visible only for that key; `override_tool` title in `tools/list`; `remove_tool` cascades; `catalog_version` increments per mutation; `slot_budget_exceeded` once filled (budget lowered to 2 via D1); 201st definition refused |
| `template.test.ts` | `{{input.x}}`, `{{json input.o}}`, `{{= input.n}}` typed, `steps.s1.structured.a[0].b`, `now.date`, unknown root throws, `{{secret:X}}` refused without `allowSecret`, allowed with it |
| `kinds.test.ts` | http via `outbound.fetch` stub: GET json + `json_path`; non-https / literal IP / `localhost` / `*.internal` / placeholder-in-host rejected at define; host outside `allowed_hosts` → `http_blocked_host`; non-2xx → `http_failed`; `max_bytes` note; timeout → `http_timeout`; `{{secret:X}}` header resolved from `HOMCP_SECRET_X` and never echoed by `describe_tool`. mcp: `outbound.fetch = SELF.fetch`; `add_upstream {name:"self", url:"https://homcp.test/mcp", auth:{kind:"bearer", value:"test-static-token"}}` caches tools; `define_tool {kind:"mcp", spec:{upstream:"self", tool:"memory_stats"}}` snapshots schema; `call_tool` proxies; a definition `loop` proxying `loop` → `hop_limit` within 3 hops. compose: `remember`→`recall` with `{{steps.s1.structured.id}}`; `on_error` both modes; self-reference rejected; depth guard |
| `upstreams.test.ts` | `list_upstreams` never leaks `auth_value`; `remove_upstream` → `upstream_in_use` while referenced, `force` deletes dependents; `upstream_tools` cached vs `refresh` |
| `memory.test.ts` | remember → recall (FTS hit; then `DROP TABLE memories_fts` → LIKE fallback still finds it, `memory_stats.fts==="off"`) → read → revise → forget (`not_found` after) → stats |
| `web.test.ts` | `/` contains the exact `claude mcp add` string, claude.ai link, `.mcp.json` block, no secrets; `/health` shape; `/api/info` equals `server_info`; `/sse` 410 + `Link`; unknown → 404 JSON |
| `owner.test.ts` | login cookie; wrong passphrase 403; POST without `Origin`/`Sec-Fetch-Site` → 403; toggle via form changes `tools/list`; grants list after a dance; revoke → bearer 401s; export redacts |

---

## 19. Security notes
Owner passphrase = consent + console + cookie HMAC (rotating invalidates console sessions, not tokens — revoke grants from `/owner`). Static token constant-time, never logged; `whoami` reports `via:"token"`. Consent re-parses `state` through the provider; S256 only; loopback any-port; rate-limited; CSP without `form-action`. `http` kind: https only, host allow-list, no redirects, ≤ 25 s, ≤ 256 KB, secrets only via env, redacted everywhere; `global_fetch_strictly_public`. `mcp` kind: prefer `secret`; `bearer` flagged plaintext. `tools/list` private cache scope; annotations are hints not authorization. Owner POSTs same-origin + `SameSite=Strict`. `.envrc`/`.dev.vars` ignored; make the repo public only after confirming they were never committed.

## 20. Risks
1. Deploy button never run against this template (id-less D1 + `npm run deploy` in Workers Builds; the Builds token is documented with KV/R2 edit but not D1); one button run from a public throwaway copy decides; fallback `"database_id": ""`. 2. Button URL assumes `Soul-Brews-Studio/higher-order-mcp`; checkout is the private `-lab-oracle` with an ignored live-token `.envrc`. 3. claude.ai shows promoted tools only after Refresh/new chat. 4. Claude Code list_changed best-effort. 5. Per-request registry read + D1 free-tier quota. 6. Consent labels shared across machines. 7. CIMD depends on the Worker fetching claude.ai metadata (spike: 200). 8. agents pins SDK 2.0.0 exactly; stale `bun.lock` vs npm in Workers Builds. 9. FTS5 triggers on D1 assumed; LIKE fallback covers. 10. `ctx.props` is an undocumented-but-provider-used field; fallback = a second handler with `authContext` (spike pattern).

## 21. Open questions
Final public repo name; whether the setup page persists an edited `MCP_SERVER_NAME`; grant-id vs label keys; memory core default; strict RFC 8707 audience later (Claude Code sends `resource`, `SP/authorize-url.txt`); global http host allow-list.

## 22. Implementation order
0. W0 contract (lead): types.ts, shims, version.ts, scope.ts, result.ts, configs, migrations, helpers; delete spike `src/index.ts` + `test/smoke.test.ts`; tsc green.
1. A shell ‖ B registry+meta/forge/identity tools ‖ C kinds+upstreams ‖ D memory ‖ E web pages+docs+scripts+plugin — five agents on disjoint files coding against §7.
2. Integration (lead): `npm run check` green; deploy to `homcp.laris.workers.dev`; connect claude.ai (CIMD) and Claude Code; define → call → promote → refresh in both; button run from a public throwaway copy; evidence in `docs/evidence/`.
