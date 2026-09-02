# homcp — a higher-order MCP server you can rename, on Cloudflare, in one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Soul-Brews-Studio/higher-order-mcp)

One Worker that speaks MCP (2026-07-28 + the 2025 lane claude.ai still uses), does OAuth for claude.ai and Claude Code, remembers things, and can **create, hide, show and proxy tools at runtime**. Deploy it as `thor-memory`, `odin-memory`, or whatever you like — the name is yours, the code never hard-codes it.

## What you get

- **OAuth 2.1 out of the box** (CIMD + DCR, PKCE S256). claude.ai and Claude Code connect with your owner passphrase and receive revocable tokens. An optional static bearer token serves scripts and CI.
- **Memory**: `remember`, `recall` (full-text search with a LIKE fallback), `read_memory`, `revise_memory`, `forget_memory`, `memory_stats`.
- **Tools that make tools**: `define_tool` (kinds: `template`, `http`, `mcp` proxy, `compose`) → `call_tool` → `promote_tool`. New tools are callable immediately and hidden from the model's tool list until you promote them (budget of 12 listed definitions).
- **Three layers of control**: built-ins → per-deploy overrides → per-connection overrides. Disable a tool for everyone, or hide it for one client only. Six tools are protected so a client can always switch things back on.
- **Stateless by design**: a fresh MCP server per request, registry and memories in D1, OAuth state in KV, no Durable Objects. Deploy is `wrangler deploy` plus migrations.
- **Renameable**: `serverInfo.name`, the approval page, the landing page and the install snippets follow one setting you can change without redeploying.

## Deploy in ten minutes

1. Click the button. On the setup page: **Project name** is the Worker name (name #1, it becomes the hostname); set the D1 database to **"+ Create new"** (the page pre-selects an existing database whose name matches, which would share its data); type a real `OWNER_PASSPHRASE` (the field is empty on purpose — generate one with `openssl rand -base64 24`); optionally set `MCP_SERVER_NAME`, for example `thor-memory` (name #2 — when empty the first label of the hostname is used). The deploy command is auto-detected as `npm run deploy`.
2. Wait for the build. `npm run deploy` runs `wrangler deploy` and then applies the D1 migrations. Open `https://<worker>.<you>.workers.dev/`.
3. The landing page prints the exact commands for *this* deploy. Copy the two Claude Code lines and click **Add to claude.ai**. Both ask for your passphrase once.

Verify from a shell:

```sh
curl -s https://YOUR-WORKER/.well-known/oauth-authorization-server | jq .client_id_metadata_document_supported   # true
curl -s https://YOUR-WORKER/health | jq -c '[.ok, .schema, .name]'                                              # [true,"ok","thor-memory"]
```

## Connect

### Claude Code (user scope = every project)

```sh
claude mcp add --transport http --scope user thor-memory https://YOUR-WORKER/mcp
claude mcp login thor-memory
```

`thor-memory` is your **client key** (name #3): tools show up as `mcp__thor-memory__recall` and so on. Pick any short key; the landing page suggests the server's own name so the two match. Run `/mcp` inside Claude Code to reconnect or refresh the tool list. Details: [docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md).

### claude.ai

Open the prefilled modal (replace the host):

```
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=thor-memory&connectorUrl=https%3A%2F%2FYOUR-WORKER%2Fmcp
```

or go to Customize → Connectors → Add → Add custom connector, type the name and the URL, and Continue. Step 2 keeps "Always required" and "Use Anthropic hosted client metadata (CIMD)" — both are detected automatically. Add creates the connector; Connect opens the approval page. The full click path and the traps (the URL must be unique in your organisation, the path must be exactly `/mcp`) are in [docs/CLAUDE_AI.md](docs/CLAUDE_AI.md).

### Codex

```sh
codex mcp add thor-memory --url https://YOUR-WORKER/mcp && codex mcp login thor-memory
```

See [docs/CODEX.md](docs/CODEX.md), including the static-token route for headless use.

### Or use the script

```sh
scripts/connect-mcp.sh claude  https://YOUR-WORKER/mcp [key]   # Claude Code, user scope, then OAuth
scripts/connect-mcp.sh codex   https://YOUR-WORKER/mcp [key]   # Codex, then OAuth
scripts/connect-mcp.sh project https://YOUR-WORKER/mcp [key]   # writes ./.mcp.json for this repository
```

The key defaults to the first DNS label of the host. Never pass tokens to the script.

### Plugin

```
/plugin marketplace add Soul-Brews-Studio/higher-order-mcp
/plugin install homcp@homcp --config server_url=https://YOUR-WORKER/mcp
```

Plugin-scoped tools carry the long prefix `mcp__plugin_homcp_homcp__…`; prefer the user-scope key when you care about tool-name length. See [plugin/README.md](plugin/README.md).

## Override per project

The same key in a repository's `.mcp.json` shadows the user-scope entry (precedence: local > project > user > plugin; entries are not merged):

```json
{ "mcpServers": { "thor-memory": { "type": "http", "url": "${HOMCP_URL:-https://odin-memory.example.workers.dev/mcp}" } } }
```

Claude Code warns "same name in more than one scope" — that is expected; sign in once per endpoint. `scripts/connect-mcp.sh project <url> thor-memory` writes this file, and [examples/project.mcp.json](examples/project.mcp.json) is a copy you can edit.

## Create your first tool

Ask Claude:

> Define a tool called `standup` that returns my standup template with a `project` argument, then promote it.

Claude calls `define_tool` (the tool is hidden but callable through `call_tool`) and then `promote_tool` (now it is in the tool list). Clients cache the list: in Claude Code run `/mcp` and reconnect; in claude.ai open the connector menu → Refresh tools list → start a new chat. How the kinds, the template language, the budget and the layers work: [docs/HIGHER_ORDER.md](docs/HIGHER_ORDER.md).

## Rename

Three names matter — the Worker name / hostname, the instance identity, and the client key — and they are independent. [docs/NAMES.md](docs/NAMES.md) explains who sets which and what changes when. The short version: ask Claude for `set_identity {name:"odin-memory"}` (or use the owner console at `/owner`) and the server is renamed without a redeploy; tool names, data and tokens stay as they are.

## Static token (optional)

For cron jobs, CI or any client without a browser:

```sh
wrangler secret put MCP_API_TOKEN          # a long random value
claude mcp add --transport http --scope user thor-memory-token https://YOUR-WORKER/mcp --header "Authorization: Bearer $HOMCP_TOKEN"
```

The token is compared in constant time before OAuth is consulted; `whoami` reports `via:"token"` so transcripts can be audited. Leave the secret unset to keep OAuth as the only door.

## Owner console

`https://YOUR-WORKER/owner` — sign in with the owner passphrase to rename the instance, enable/disable/promote/demote/remove tools at the deploy layer, delete upstreams, revoke OAuth grants, read the audit log and download a redacted export. Every change notifies connected clients that the tool list changed.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars        # set OWNER_PASSPHRASE
npm run db:migrate:local
npm run dev                           # http://localhost:8787
npm run check                         # name guard + tsc + vitest
npm run deploy                        # wrangler deploy + remote migrations
```

Tests run in the Workers runtime (`@cloudflare/vitest-pool-workers`) with the real migrations; every request goes through `SELF.fetch("https://homcp.test/...")`.

## How it works · Limits & security · Operations

- [docs/HIGHER_ORDER.md](docs/HIGHER_ORDER.md) — define → call → promote, the four kinds, the template language, layers and budget, error codes
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — migrations, renaming, revoking grants, rotating the passphrase, D1 quota, error 1042, custom domains
- [docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md) · [docs/CLAUDE_AI.md](docs/CLAUDE_AI.md) · [docs/CODEX.md](docs/CODEX.md) — per-client guides
- [docs/NAMES.md](docs/NAMES.md) — the three names
- [docs/DESIGN.md](docs/DESIGN.md) — the full design this implementation follows

## Repository layout

```
src/worker.ts            static-token door, then the OAuthProvider
src/oauth/provider.ts    OAuth 2.1 (CIMD + DCR, PKCE), /mcp behind it
src/mcp/                 stateless MCP handler, per-request server factory, principal, result helpers
src/registry/            D1 registry, catalog resolution (layers), names, dispatch, kinds, upstream client
src/tools/builtin/       the 22 built-in tools (meta, forge, identity, upstreams, memory)
src/memory/              memory store (FTS5 with LIKE fallback)
src/web/                 landing page, consent page, owner console, snippets
migrations/              D1 schema (registry, memory)
scripts/                 deploy.mjs, connect-mcp.sh, check-names.mjs
plugin/                  Claude Code plugin; .claude-plugin/marketplace.json makes this repo a marketplace
test/                    vitest + workers pool
```

## License

MIT — see [LICENSE](LICENSE).
