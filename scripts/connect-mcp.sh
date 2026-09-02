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
