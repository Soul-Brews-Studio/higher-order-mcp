# homcp Claude Code plugin

This directory is a Claude Code plugin that registers one deployed homcp server as a plugin-scoped MCP server. The repository root carries the matching marketplace file (`.claude-plugin/marketplace.json`), so the repo itself is the marketplace.

## Install

Inside Claude Code:

```
/plugin marketplace add Soul-Brews-Studio/higher-order-mcp
/plugin install homcp@homcp --config server_url=https://YOUR-WORKER/mcp
```

`server_url` is the only setting: your deployment's MCP endpoint, path exactly `/mcp`. The plugin's `.mcp.json` expands it as `${user_config.server_url}`.

Then authorize once: run `/mcp` inside Claude Code, pick the `homcp` server that the plugin added, and approve with your owner passphrase in the browser window that opens.

## What the tool names look like

Plugin-scoped servers get a long prefix: tools appear as `mcp__plugin_homcp_homcp__<tool>` (for example `mcp__plugin_homcp_homcp__recall`). Every character of that prefix counts against the 128-character limit on full tool names, and the plugin key cannot be shortened.

If you want the short prefix `mcp__<key>__<tool>` instead, use the user-scope install the landing page prints:

```
claude mcp add --transport http --scope user thor-memory https://YOUR-WORKER/mcp
claude mcp login thor-memory
```

or, for one repository only, `scripts/connect-mcp.sh project https://YOUR-WORKER/mcp thor-memory`, which writes a `.mcp.json` with the same key (project scope wins over user scope; see `docs/CLAUDE_CODE.md`).

## Files

- `.claude-plugin/plugin.json` — plugin manifest with the `server_url` user setting
- `.mcp.json` — the MCP server entry that uses it
