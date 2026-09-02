# How the higher-order part works

homcp is an MCP server whose tools can create, hide, show and proxy other tools at runtime. This page explains the model behind it: the loop (define → call → promote), the four kinds of defined tools, the template language, the three layers of control, the budget, and the error contract. Everything here is enforced server-side; the model is only ever offered what the layers allow.

## The loop: define → call → promote

1. **`define_tool`** stores a definition in D1. It is validated immediately (name, schema, spec, and — for `http`/`mcp` kinds — the host policy or a live upstream check). The new tool is **enabled but hidden**: it is registered on the server, so `call_tool {name, arguments}` can run it right away, but it is not in `tools/list`, so it costs the model no context.
2. **`call_tool`** runs any enabled tool by name, hidden or not, and returns its result verbatim. Use it to try a definition before spending a slot on it.
3. **`promote_tool`** lists the tool in `tools/list` (spending one of the 12 promoted slots at the deploy layer). **`demote_tool`** hides it again; it stays callable. **`remove_tool {name, confirm:true}`** deletes a definition and every override that pointed at it.

Every mutation bumps `catalog_version`, appends a registry event, sends `notifications/tools/list_changed` to open streams of the same isolate, and ends its text with the refresh hint (clients cache tool lists: Claude Code `/mcp` → reconnect; claude.ai connector menu → Refresh tools list → new chat).

## The 22 built-in tools

| Group | Tools | Listed by default |
|---|---|---|
| Meta (protected) | `list_tools`, `describe_tool`, `call_tool`, `toggle_tool`, `promote_tool`, `demote_tool` | yes |
| Forge | `define_tool` | yes · `override_tool`, `remove_tool` hidden |
| Identity | `whoami`, `server_info` | yes · `set_identity` hidden |
| Upstreams | `add_upstream`, `remove_upstream`, `list_upstreams`, `upstream_tools` | hidden |
| Memory | `remember`, `recall`, `read_memory`, `revise_memory`, `forget_memory`, `memory_stats` | yes |

Fifteen are listed on a fresh deploy; seven are hidden and reachable through `call_tool` (or promote them). The six **protected** tools are always enabled and listed, for every connection, so a client can always see the catalog and switch things back on. Destructive tools (`remove_tool`, `remove_upstream`, `forget_memory`) carry `_meta["anthropic/requiresUserInteraction"]`, and the three discovery tools carry `_meta["anthropic/alwaysLoad"]`.

## Kinds

A definition is `{ name, kind, title?, description, input_schema?, spec, annotations?, promote?, replace? }`. `input_schema` is JSON Schema (an object at the root; property names `[A-Za-z0-9_.-]`, at most 8 KB and 4 levels deep). `spec` depends on the kind.

### `template` — render text from arguments

```json
{ "name": "standup", "kind": "template", "description": "My standup template",
  "input_schema": { "type": "object", "properties": { "project": { "type": "string" } }, "required": ["project"] },
  "spec": { "text": "## {{input.project}} — {{now.date}}\n- Yesterday:\n- Today:\n- Blockers:" } }
```

`format:"json"` parses the rendered text into `structuredContent`. Defaults: read-only, idempotent, not open-world.

### `http` — one HTTPS request

```json
{ "name": "weather", "kind": "http", "description": "Current weather for a city",
  "input_schema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] },
  "spec": { "method": "GET", "url": "https://api.example.com/v1/weather?q={{input.city}}",
            "headers": { "Authorization": "Bearer {{secret:WEATHER}}" }, "response": "json", "json_path": "current" } }
```

Rules, checked when you define and again when you call: `https://` only; the host must be a DNS name (no literal IPs, `localhost`, `*.internal`, `*.local`, `*.home.arpa`); no `{{` inside the host; the rendered host must be in `allowed_hosts` (defaults to the URL's host); redirects are not followed; `timeout_ms` ≤ 25 000; `max_bytes` ≤ 256 KB. Secrets come only from Worker secrets named `HOMCP_SECRET_<NAME>` (`wrangler secret put HOMCP_SECRET_WEATHER`) through `{{secret:NAME}}`, which is allowed in `url` and `headers` only and is never echoed by `describe_tool` or the export. Defaults: read-only for `GET`, destructive for `DELETE`/`PUT`/`PATCH`, idempotent unless `POST`, open-world. Errors: `http_blocked_host`, `http_timeout`, `http_failed {status}`, `http_too_large`.

### `mcp` — proxy one tool of another MCP server

First register the upstream once (hidden tool, reachable through `call_tool`):

```json
{ "name": "add_upstream", "arguments": { "name": "docs", "url": "https://docs.example.com/mcp", "auth": { "kind": "secret", "value": "DOCS" } } }
```

`auth.kind` is `none`, `bearer` (token stored in D1, flagged as plaintext) or `secret` (the name of a `HOMCP_SECRET_*` Worker secret — preferred). The server connects once, caches the upstream's tool list and answers with a ready-made example. Then:

```json
{ "name": "search_docs", "kind": "mcp", "description": "Search the docs",
  "spec": { "upstream": "docs", "tool": "search", "bind": { "limit": 5 } } }
```

With `schema:"snapshot"` (default) the upstream tool's input schema, minus the bound keys, becomes the definition's `input_schema`; its title, description and annotations are the defaults. At call time a fresh client connects per request (`versionNegotiation: auto`, 10 s connect + `timeout_ms` call) and the upstream's result is passed through, error text prefixed with `upstream <name>:`. Every hop adds an `X-Homcp-Hop` header; a chain that crosses three homcp deployments is cut with `hop_limit`, so a definition that proxies its own deployment cannot recurse forever.

### `compose` — run steps in sequence

```json
{ "name": "note_and_find", "kind": "compose", "description": "Remember, then recall",
  "input_schema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
  "spec": { "steps": [
      { "id": "s1", "tool": "remember", "args": { "content": "{{input.text}}" } },
      { "id": "s2", "tool": "read_memory", "args": { "id": "{{steps.s1.structured.id}}" } } ],
    "on_error": "stop", "output": "last" } }
```

Up to 8 steps; each step's tool must exist (hidden is fine, disabled is refused); no self-reference; nesting is capped at depth 3; wall clock ≤ 45 s (Claude Code's request timeout is 60 s). `on_error:"stop"` fails with `compose_step_failed {step}` and the partial steps in `details`; `"continue"` carries on. `output:"last"` returns the last step's content plus `structuredContent {steps, last}`; `"all"` returns a section per step. Annotations: read-only if all steps are, destructive if any is, idempotent if all are, open-world if any is.

## The template language

`{{expr}}` inserts a value as text (a missing value renders as an empty string and adds a warning to `_meta.homcp.warnings`); `{{json expr}}` inserts JSON; a whole-string `{{= expr}}` inside `args`, `body` or `bind` passes the raw typed value; `{{secret:NAME}}` resolves a `HOMCP_SECRET_NAME` Worker secret (http `url`/`headers` only).

Roots: `input.<key>[.path]`, `steps.<id>.text | structured[.path] | isError`, `principal.clientKey`, `identity.name`, `now.iso | date`. Paths look like `a.b[0].c`. An unknown root is rejected at define time (`spec_invalid`) by a dry render with empty input.

## Three layers of control

```
BUILTIN   code defaults: enabled, listed unless hiddenByDefault
   ↓
DEPLOY    tool_overrides scope=deploy (toggle_tool / promote_tool / override_tool / owner console)
   ↓      definitions enter here as enabled + hidden
CLIENT    tool_overrides scope=client for this connection's clientKey (toggle_tool … scope:"client")
```

- `enabled` only narrows downward: a deploy-level disable cannot be undone by a client (`tool_disabled` names the deciding layer). A client can disable a tool for itself and restore it later.
- `promoted` is decided by the most specific layer: client > deploy > built-in default.
- Deploy-level `title`/`description` overrides (`override_tool`) win over the code or the definition.
- Protected tools ignore every override.
- `tools/list` = enabled ∧ promoted, sorted by name, identical for every request of the same principal; registration follows the same order, so the list is deterministic.

`clientKey` is the label approved on the consent page for OAuth connections (default `claude-code` for Claude Code, `claude` for claude.ai), or `token` for the static bearer. `whoami` shows it.

## Budget

`settings.promoted_budget` (default 12) caps the number of **promoted definitions** per layer. It is enforced when you promote (`promote_tool`, `define_tool {promote:true}` → `slot_budget_exceeded` with the current list); it never hides anything after the fact — `list_tools` warns when a layer is over budget. The reasoning: in earlier servers generated tools ended up as 61 % of the model's context. Hidden tools are free.

There is also a hard cap of 200 definitions per deploy (D1 row-read economy) and a per-name budget of `min(64, 121 − len(identity))` characters so `mcp__<key>__<tool>` stays under the API's 128-character limit.

## Error contract

Tools never throw. A failure is `{ isError: true, content: [{ type:"text", text:"<code>: <message>\n<hint>" }], structuredContent: { error: { code, message, hint?, details? } } }` with `code` one of:

`invalid_name` · `name_too_long` · `name_taken` · `unknown_tool` (with nearest names) · `tool_disabled` · `protected_tool` · `not_a_definition` · `slot_budget_exceeded` · `invalid_arguments` · `schema_invalid` · `spec_invalid` · `unknown_upstream` · `upstream_unreachable` · `upstream_tool_missing` · `upstream_error` · `upstream_in_use` · `http_blocked_host` · `http_timeout` · `http_failed` · `http_too_large` · `compose_step_failed` · `depth_exceeded` · `hop_limit` · `db_not_migrated` · `not_found` · `forbidden` · `internal`

Text results are truncated at 100 000 characters. `describe_tool` shows a tool's schema, annotations, override rows per layer, its spec with secrets redacted, and its full Claude Code name with the length.

## What is deliberately not here

No Durable Objects, no per-session state, no elicitation or sampling, no multi-user auth, no tool aliases, no cross-isolate fan-out of `list_changed` (the refresh hint and `catalog_version` make staleness visible instead). The design that fixes these choices, with the evidence behind each, is `docs/DESIGN.md`.
