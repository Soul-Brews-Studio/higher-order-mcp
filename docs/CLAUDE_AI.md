# Connecting claude.ai

claude.ai connects to homcp as a **custom connector** over Streamable HTTP with OAuth. This is the flow that was verified end to end on a live deployment (Claude Code 2.1.257 was verified the same day; see `docs/evidence/`).

## The short way: the prefill link

The landing page of your deployment has an **Add to claude.ai** button. It opens the connector modal with the name and URL already filled in:

```
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=thor-memory&connectorUrl=https%3A%2F%2FYOUR-WORKER%2Fmcp
```

`connectorName` becomes the connector's name (name #3 in [NAMES.md](NAMES.md)); `connectorUrl` is your MCP endpoint, URL-encoded. From there, continue at step 4 below.

## The manual way, click by click

1. In claude.ai open **Customize** → **Connectors**.
2. Click **Add**, then **Add custom connector**.
3. Fill in **Name** (for example `thor-memory`) and **Remote MCP server URL** (`https://YOUR-WORKER/mcp`). The path must be exactly `/mcp`. Click **Continue**.
4. claude.ai probes the server. The second step shows what it found:
   - **Authentication: Always required (Detected)** — the server answered `401` with protected-resource metadata, so OAuth is on.
   - **Use Anthropic hosted client metadata (CIMD) (Recommended)** — the server advertises `client_id_metadata_document_supported: true`, so claude.ai identifies itself with its hosted client document instead of dynamic registration. Leave it on.
   - **Additional request headers** — leave empty. Do not paste a static token here; use OAuth.
   - **Transport: Streamable HTTP**.
5. Click **Add**. The connector now exists but is **not connected yet**.
6. Click **Connect** on the connector. A window opens on your server's approval page: "Connect **Claude** to **thor-memory**". Type the **owner passphrase**, optionally adjust the connection label, and approve.
7. Back in claude.ai the connector shows as connected and lists the tools under Tool permissions (fifteen by default, grouped by their annotations: read-only, write, destructive).

Start a new chat and the tools are available.

## Things that trip people up

- **The URL must be unique in your organisation.** claude.ai refuses to add a connector whose URL is already registered by anyone in the org ("URL already exists"). Remove the old connector first, or use a different hostname (a custom domain, or a second deploy).
- **The endpoint path is exactly `/mcp`.** `/sse`, `/mcp/` with a trailing slash, or the bare origin will not work; `/sse` answers `410 Gone` on purpose.
- **Tool lists are cached.** After `define_tool` + `promote_tool`, `toggle_tool`, a rename or an owner-console change, open the connector's menu → **Refresh tools list**, then **start a new chat**. Until then `list_tools` shows the real catalog and `call_tool` can run any enabled tool.
- **Discovery is cached for a few minutes.** Right after a deploy claude.ai may still remember the old metadata (roughly five minutes). Wait and retry rather than re-adding the connector.
- **Edge blips after a deploy.** For a few seconds after `wrangler deploy` Cloudflare may answer error 1042 while the new version rolls out. Retry.
- **Renaming the server does not rename the connector.** `set_identity` changes what the approval page and `serverInfo.name` say; the connector keeps the name you typed.
- **Changing the hostname makes a new connector.** Tokens stay valid (no audience pinning), but claude.ai keys connectors by URL, so add the new URL as a new connector and remove the old one.
- **The protocol lane.** claude.ai still speaks the 2025 MCP lane (`2025-06-18`); homcp serves it alongside the 2026-07-28 lane, statelessly, without session ids. You do not need to do anything.

## What happens on the server

- `GET /.well-known/oauth-protected-resource/mcp` tells claude.ai which authorization server to use (this same origin).
- `GET /.well-known/oauth-authorization-server` advertises PKCE `S256`, CIMD, and the dynamic-registration endpoint (used only by clients without a CIMD document).
- `GET /authorize` renders the approval page; the server fetches claude.ai's client metadata document to display the client name.
- `POST /authorize` checks the passphrase (rate-limited: ten failures per ten minutes per address), re-parses the request through the OAuth provider, and issues a code; `POST /oauth/token` exchanges it for an access token (1 h) and a refresh token (30 days).
- Every MCP request carries the bearer; the server resolves it to a **principal** with the connection label you approved (`clientKey`). Per-connection tool overrides are keyed by that label.

## Removing access

Either delete the connector in claude.ai, or open `https://YOUR-WORKER/owner` → **Connections** and revoke the grant. Revoking invalidates the access and refresh tokens immediately; claude.ai will ask you to connect again.
