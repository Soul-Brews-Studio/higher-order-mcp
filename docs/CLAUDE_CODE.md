# Connecting Claude Code

Claude Code connects to homcp over Streamable HTTP with OAuth. The verified flow (Claude Code 2.1.257): `claude mcp add` at user scope, `claude mcp login`, approve in the browser, done. Claude Code identifies itself with its hosted client metadata document (CIMD) and a loopback redirect (`http://localhost:3118/callback`), so no dynamic client registration rows are ever written.

## Install at user scope (every project on this machine)

```sh
claude mcp add --transport http --scope user thor-memory https://YOUR-WORKER/mcp
claude mcp login thor-memory
```

- `thor-memory` is the **client key**. Tools appear in the model's context as `mcp__thor-memory__<tool>` (for example `mcp__thor-memory__recall`). Any short name made of letters, digits, `-` and `_` works; the landing page suggests the server's own identity so the two match.
- `claude mcp login` opens the approval page in your browser. Type the owner passphrase, keep or edit the connection label (it defaults to `claude-code` and becomes this connection's `clientKey` on the server), and approve. Claude Code prints "Authenticated with thor-memory".
- On a headless machine or inside tmux, use `claude mcp login thor-memory --no-browser` and open the printed URL anywhere.
- `claude mcp list` shows the server as Connected. The user-scope entry lives in `~/.claude.json`.

`scripts/connect-mcp.sh claude https://YOUR-WORKER/mcp [key]` runs exactly these two commands.

## Refreshing tools

Claude Code caches the tool list per session. After `define_tool` + `promote_tool`, `toggle_tool`, `set_identity`, or a change in the owner console:

- inside a session run `/mcp`, pick the server, and reconnect (this also re-fetches the list), or
- wait for the `list_changed` notification — the server sends it, and Claude Code re-fetches when the notification reaches the open stream. It is best-effort: only the isolate that handled the mutation can notify, so treat `/mcp` as the reliable path.

`list_tools` always shows the live catalog, hidden tools included, and `call_tool {name, arguments}` runs any enabled tool without a refresh. A direct `tools/call` on a hidden (not promoted) tool answers "Tool X disabled": either `promote_tool` it or go through `call_tool`.

## Override one project

Drop a `.mcp.json` at the repository root with the **same key**:

```json
{
  "mcpServers": {
    "thor-memory": { "type": "http", "url": "${HOMCP_URL:-https://odin-memory.example.workers.dev/mcp}" }
  }
}
```

- Scopes are resolved local > project > user > plugin, and entries are **not merged**: the project entry replaces the user entry for that key, and the tool prefix stays `mcp__thor-memory__`.
- Claude Code warns "same name in more than one scope with different endpoints". That is expected; sign in once per endpoint (each endpoint has its own tokens).
- `${HOMCP_URL:-...}` is expanded by Claude Code from the environment, with the literal after `:-` as the default, so one file can point at a staging deploy on your laptop and at production in CI.
- `scripts/connect-mcp.sh project https://YOUR-WORKER/mcp thor-memory` writes this file; `examples/project.mcp.json` is a template.

## Plugin install

```
/plugin marketplace add Soul-Brews-Studio/higher-order-mcp
/plugin install homcp@homcp --config server_url=https://YOUR-WORKER/mcp
```

Plugin-scoped servers are named `plugin:homcp:homcp`, so tools appear as `mcp__plugin_homcp_homcp__<tool>`. That prefix is long and cannot be shortened, and every character counts against the 128-character limit on full tool names. Prefer the user-scope key when you define your own tools; the plugin is convenient when you want one install step for a team.

## Tool names and the 128-character limit

The Claude API rejects any request that includes a tool named longer than 128 characters, and Claude Code neither truncates nor warns. With `mcp__<key>__<tool>`, that leaves `121 − len(key)` characters for the tool itself. The server knows its own identity and enforces `min(64, 121 − len(identity))` when you `define_tool` (`name_too_long`); if your key is longer than the identity, keep your tool names correspondingly shorter. Dots are not allowed in tool names because Claude Code rewrites `.` to `_`.

## Static token instead of OAuth

For scripts or a second, non-interactive install:

```sh
wrangler secret put MCP_API_TOKEN
claude mcp add --transport http --scope user thor-memory-token https://YOUR-WORKER/mcp --header "Authorization: Bearer $HOMCP_TOKEN"
```

The shell expands `$HOMCP_TOKEN` when you run `claude mcp add`, so the value is stored in `~/.claude.json`; keep that file private. Requests with the token bypass OAuth entirely, and `whoami` reports `via:"token"`, `clientKey:"token"`, so per-connection overrides for the token principal are separate from your OAuth connection.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401` / "needs authentication" after it worked | grant revoked in the owner console, or refresh token expired (30 days idle) | `claude mcp login thor-memory` |
| "Tool X disabled" on a direct call | the tool is defined but not promoted | `promote_tool {name}` or `call_tool {name, arguments}` |
| tool missing after you defined it | cached list | `/mcp` → reconnect |
| `name_too_long` from `define_tool` | key + tool name would exceed 128 | shorter tool name, or a shorter key |
| "same name in more than one scope" | intentional project override | ignore; sign in once per endpoint |
| `hop_limit` in a tool result | a definition proxies its own deployment | check `list_upstreams`; remove the loop |
| `db_not_migrated` | fresh deploy before migrations | `npm run db:migrate:remote` |

To remove the server: `claude mcp remove thor-memory -s user`. Revoking the grant server-side is done in `/owner` → Connections.
