# Connecting Codex

Codex registers remote MCP servers by name and URL and can run the same OAuth flow as Claude Code. The Codex path was not part of the live spike (Claude Code and claude.ai were); it follows the same standards (Streamable HTTP, OAuth 2.1 with PKCE, protected-resource metadata), so it is expected to work unchanged. Please open an issue with the exact output if it does not.

## OAuth (interactive)

```sh
codex mcp add thor-memory --url https://YOUR-WORKER/mcp
codex mcp login thor-memory
```

`thor-memory` is the server name inside Codex and, as in Claude Code, becomes part of every tool's name, so keep it short (letters, digits, `-`, `_`). `codex mcp login` opens the server's approval page: type the owner passphrase, keep or change the connection label, approve. The label becomes this connection's `clientKey` on the server; the default label is derived from the client name Codex presents.

`scripts/connect-mcp.sh codex https://YOUR-WORKER/mcp [key]` runs these two commands.

## Static token (headless, CI)

If your Codex environment cannot open a browser, use the static bearer token:

1. On the server: `wrangler secret put MCP_API_TOKEN` (a long random value).
2. In Codex, attach the token as an `Authorization: Bearer …` header to the server entry. Codex reads the value from an environment variable named in its config rather than storing it inline — check `codex mcp add --help` for the current flag, or set it in `~/.codex/config.toml` under `[mcp_servers.thor-memory]` next to `url`.
3. Export the variable in the environment that runs Codex. Never paste the token into a chat; on the server `whoami` reports `via:"token"` for these requests so they are easy to audit.

## After connecting

- Ask for `list_tools` to see everything, including hidden tools; `call_tool {name, arguments}` runs any enabled tool.
- `define_tool` → `call_tool` → `promote_tool` is the create-a-tool loop; Codex caches the tool list, so restart or reconnect the server after promoting.
- Per-connection switches (`toggle_tool` with `scope:"client"`) apply to the label you approved; the owner console shows every connection under **Connections** and can revoke it.

## Removing

`codex mcp remove thor-memory` locally; revoke the grant in `https://YOUR-WORKER/owner` → Connections to invalidate the tokens server-side.
