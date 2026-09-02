# The three names

A deployed homcp server has three names that matter and one that does not. They are set by different people, show up in different places, and changing one never changes the others.

| # | Name | Who sets it | Where it shows | Rule |
|---|---|---|---|---|
| 1 | **Worker name / hostname** | Deploy-button "Project name" (rewrites wrangler `name`), `wrangler.jsonc:name`, or a dashboard custom domain | the URL `https://<name>.<subdomain>.workers.dev/mcp` | Workers Builds requires dashboard name == wrangler `name` (`WRANGLER_CI_OVERRIDE_NAME`) |
| 2 | **Instance identity** (`serverInfo.name`, approval-page and landing copy, `/health`, `/api/info`, `whoami`, `server_info`) | this server. Precedence: D1 `settings.identity_name` (`set_identity` / `/owner`) → var `MCP_SERVER_NAME` when non-empty → first DNS label of the request Host (`thor-memory.buildwithoracle.com` → `thor-memory`; `localhost` skipped) → `homcp` | approval page ("Connect **Claude** to **thor-memory**"), landing, tools | `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` — exactly what `claude mcp add` accepts, so "key = identity" snippets always work |
| 3 | **Client key** | Claude Code: `claude mcp add <key>` or the `.mcp.json` key → prefix `mcp__<key>__`; claude.ai: the Name typed in "Add custom connector" (`connectorName=`); Codex: `codex mcp add <name>` | tool names in the model's context, `/mcp` panel, connectors list | every key char costs one tool-name char: `len(tool) <= 121 − len(key)`; landing suggests key = identity |
| — | `McpServer` `title` | this server (optional) | nothing today (neither client displays serverInfo.name/title) | omitted unless set via `set_identity` |

## Rules

- Renaming #2 never touches tool names, D1/KV names, KV prefixes, the `homcp_owner` cookie or issued tokens.
- The D1 setting wins over the var, so a rename never needs a redeploy.
- The Deploy button does not persist edited `vars`, and a Workers Builds redeploy re-applies `wrangler.jsonc`, so **`set_identity` is the durable rename**. `MCP_SERVER_NAME` is a convenience for the first deploy.
- `set_identity` re-checks every definition against the new name budget and lists offenders (it never deletes anything).
- Renaming does not rename a claude.ai connector or a Claude Code key; those keep whatever you typed.
- claude.ai refuses a URL already registered in the organisation; remove the old connector first.
- A hostname change keeps tokens valid (no audience pinning), but claude.ai treats the new URL as a new connector.

## How the identity is resolved

```
settings.identity_name   (set_identity tool or /owner)   ─┐  first valid one wins
MCP_SERVER_NAME          (wrangler var, non-empty)         ├─▶ identity.name
first DNS label of Host  (thor-memory.example.com → thor-memory; localhost and IPs skipped)
"homcp"                  (the product name, last resort)  ─┘
```

Every candidate must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`; anything else falls through to the next candidate. The `source` field in `/health`, `server_info` and the owner console tells you which one won.

## Why the character set is so strict

Claude Code exposes every tool as `mcp__<key>__<tool>`, and the Claude API rejects a request whose tool name is longer than 128 characters — Claude Code neither truncates nor warns. With the key equal to the identity, the tool-name budget is `min(64, 121 − len(identity))`, which the server enforces at `define_tool` time (`name_too_long`). Dots are excluded from tool names because Claude Code rewrites `.` to `_`, which would silently alias two tools.

## Renaming, step by step

1. Ask Claude: `set_identity {name:"odin-memory"}` — or open `/owner`, Identity tab, type the name, Save.
2. The next `initialize` reports `serverInfo.name: "odin-memory"`; `/`, `/health` and `/api/info` follow immediately.
3. Nothing else changes. Existing Claude Code keys and claude.ai connectors keep their old names; new installs get snippets with the new name.
4. If any defined tool is now longer than the budget, the result lists it. Rename or remove those definitions; they keep working meanwhile for clients whose key is short enough.

To go back to the hostname-derived name: `set_identity {reset:true}` or "Reset to defaults" in the console.
