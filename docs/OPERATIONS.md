# Operations

Day-two tasks for a homcp deployment: migrations, renaming, access control, secrets, quotas, and the errors you will actually see.

## Deploying

- **Button**: the setup page asks for the project name (Worker name = hostname), creates the D1 database and the KV namespace, prompts for `OWNER_PASSPHRASE` (required) and `MCP_SERVER_NAME` (optional), and runs `npm run deploy`. The button rewrites `name` and the resource ids in the cloned `wrangler.jsonc`; it does not persist edited `vars`.
- **Checkout**: `npm install && npm run deploy`. `scripts/deploy.mjs` runs `wrangler deploy` (which provisions the id-less `OAUTH_KV` and `DB` bindings on first run) and then `wrangler d1 migrations apply DB --remote`. On an interactive first deploy wrangler may write ids into `wrangler.jsonc`; do not commit them to the template.
- **Dry run**: `npm run deploy:dry-run`.
- Workers Builds uses npm (`package-lock.json`); there is no bun lockfile on purpose.

## Migrations and the "schema missing" state

Migrations live in `migrations/` and run by binding name: `npm run db:migrate:remote` (production) or `npm run db:migrate:local` (wrangler dev). The Worker never runs DDL itself. Between `wrangler deploy` and the migration — or if a migration failed — the server keeps working in a degraded mode:

- `/health` reports `"schema":"missing"`; the landing page and the owner console show a yellow box.
- Only built-in tools are registered; registry and memory tools answer `db_not_migrated`.
- The fix is always the same: `npm run db:migrate:remote`.

## Renaming

`set_identity {name:"odin-memory"}` from any connected client (hidden tool; use `call_tool` if it is not promoted), or `/owner` → Identity. The setting lives in D1 and wins over `MCP_SERVER_NAME`, so the rename survives redeploys. Tool names, data, cookies and tokens are untouched; Claude Code keys and claude.ai connector names keep what you typed. `set_identity {reset:true}` returns to the var/hostname-derived name. See [NAMES.md](NAMES.md).

## Access control

- **Owner passphrase** (`OWNER_PASSPHRASE`): typed on the OAuth approval page and the owner console. Rotate with `wrangler secret put OWNER_PASSPHRASE`. Rotating invalidates owner-console sessions (their cookie is an HMAC over the passphrase) but **not** issued OAuth tokens; revoke those separately.
- **Revoking a client**: `/owner` → Connections → Revoke. The grant's access and refresh tokens die immediately; the client must sign in again. Grants are also listed per label so you can tell `claude-code` on your laptop from `claude` (claude.ai) or a label you typed for a colleague's machine.
- **Static token** (`MCP_API_TOKEN`): optional. Add or rotate with `wrangler secret put MCP_API_TOKEN`; remove with `wrangler secret delete MCP_API_TOKEN` to close that door. It is compared in constant time before the OAuth provider sees the request and is never logged.
- **Rate limits**: ten failed passphrase attempts per address per ten minutes on both `/authorize` and `/owner/login` (KV keys `ratelimit:authorize:<ip>`, `ratelimit:owner-login:<ip>`).
- **Owner console POSTs** require the session cookie *and* a same-origin request (`Sec-Fetch-Site: same-origin` or a matching `Origin`), with `SameSite=Strict` on the cookie.

## Secrets for defined tools

`http` definitions and `mcp` upstreams read secrets from Worker secrets named `HOMCP_SECRET_<NAME>` (`NAME` matches `^[A-Z][A-Z0-9_]*$`):

```sh
wrangler secret put HOMCP_SECRET_WEATHER
```

Reference them as `{{secret:WEATHER}}` in an http `url`/`headers`, or as `auth: { kind:"secret", value:"WEATHER" }` on an upstream. They are resolved at call time and never appear in `describe_tool`, `list_upstreams`, the export or logs. The `bearer` auth kind stores the token in D1 and is flagged as plaintext; prefer `secret`.

## Storage

- **D1 (`DB`)**: `settings`, `tool_defs`, `tool_overrides`, `upstreams`, `registry_events`, `memories` (+ FTS5 index). Every MCP request reads one snapshot in a single `db.batch`; every mutation is one batch that also bumps `catalog_version` and appends an event.
- **KV (`OAUTH_KV`)**: OAuth provider data (`client:*`, `grant:*`, `token:*`, `refresh:*`), owner sessions (`owner-session:<uuid>`, 12 h) and rate-limit counters (10 min). KV is eventually consistent (up to 60 s across locations), which is why nothing that must be visible immediately lives there.
- **Backup**: `/owner` → Export downloads a redacted JSON of settings, definitions, overrides and upstreams (no secrets, no cached upstream tool lists). For a full copy use `wrangler d1 export DB --remote --output backup.sql`.

## D1 quota (free tier)

The free tier allows 5 million row reads per day per account, reset at 00:00 UTC. Every MCP request reads the settings, definitions and overrides once, so a busy day with many definitions adds up; the spike hit the ceiling (D1 error code 7500), after which every query — including migrations — fails until midnight UTC. Symptoms: `db_not_migrated`-like failures on a migrated database, `internal` tool errors, `/health` still `ok` but tools failing. Options: wait for the reset, move to the paid plan, or trim definitions (`remove_tool`) and memories. The 200-definition cap exists to keep the per-request read small.

## Errors you will see

| Where | What | Meaning |
|---|---|---|
| any URL, seconds after a deploy | Cloudflare error **1042** | the new version is still rolling out; retry |
| claude.ai, minutes after a deploy | old metadata / "could not connect" | discovery cache (~5 min); wait, then Refresh tools list |
| claude.ai, adding a connector | "URL already exists" | another connector in your org has this URL; remove it first |
| `POST /mcp` | `401` with `WWW-Authenticate: Bearer resource_metadata=…` | no or invalid bearer — normal for the first contact; clients then start OAuth |
| `GET /mcp` | `405` | the legacy lane only accepts POST; nothing is wrong |
| `GET /sse` | `410` | the SSE transport is retired; use `/mcp` |
| `/authorize` | `502 could not fetch client metadata` | the Worker could not fetch the client's CIMD document; retry |
| tool result | `hop_limit` | a definition proxies its own deployment through an upstream; check `list_upstreams` |
| tool result | `db_not_migrated` | run `npm run db:migrate:remote` |
| consent page | `503` | `OWNER_PASSPHRASE` is not set |

## Custom domains and host checks

Add a custom domain in the Cloudflare dashboard; nothing in the config needs to change. With `MCP_SERVER_NAME` empty and no D1 setting, the identity follows the first label of the new host (`thor-memory.example.com` → `thor-memory`). Tokens stay valid across hostnames (no audience pinning), but claude.ai treats the new URL as a new connector.

By default the MCP handler does not check the `Host` header. To restrict it, set the optional var `ALLOWED_HOSTNAMES` (comma-separated) in `wrangler.jsonc` or the dashboard.

## Observability

`observability.enabled` is on in `wrangler.jsonc`: Workers Logs shows `console.error("tool_failed", name, kind, …)` for tool crashes, `oauth <code> <status>` for provider errors and `mcp` for handler errors. The registry audit trail (`registry_events`, last 100 in `/owner` → Log) records every definition, override, upstream and identity change with the acting principal (`clientKey` or `owner-console`), plus consent approvals and denials.

## Checks

```sh
npm run check      # scripts/check-names.mjs (no deployment names baked into src/) + tsc + vitest
npm test           # vitest only (Workers runtime, real migrations, SELF.fetch)
npm run typecheck
```

Before making a copy of this repository public, confirm `.dev.vars` and `.envrc` were never committed (`git log --all -- .dev.vars .envrc` should print nothing).
