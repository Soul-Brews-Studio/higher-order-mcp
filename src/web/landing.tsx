// src/web/landing.tsx [E] — GET / (§15.2). Public, no secrets, live-origin snippets with data-testid on every one.
// Pure rendering: the caller (src/web/app.tsx) resolves the catalog and passes it in — see loadWebCatalog in ./owner.tsx.
import { REFRESH_HINT } from "../mcp/result";
import { VERSION } from "../version";
import type { ResolvedCatalog } from "../types";
import { Layout, Pill, Snippet, renderDocument } from "./layout";
import { MARKETPLACE_REPO, installSnippets, mcpEndpoint, toolCounts, type WebScope } from "./snippets";

export interface LandingOptions { cimd: boolean }

export const ENDPOINTS: ReadonlyArray<[path: string, what: string]> = [
  ["/mcp", "Streamable HTTP MCP endpoint (POST only; GET and DELETE answer 405)"],
  ["/.well-known/oauth-protected-resource/mcp", "protected-resource metadata (RFC 9728)"],
  ["/.well-known/oauth-authorization-server", "authorization-server metadata (RFC 8414)"],
  ["/authorize", "consent page: owner passphrase, connection label"],
  ["/oauth/token", "token endpoint (authorization_code + refresh_token, PKCE S256)"],
  ["/oauth/register", "dynamic client registration (fallback when a client has no CIMD document)"],
  ["/api/info", "this page as JSON (ServerInfoPayload)"],
  ["/health", "liveness + schema + catalog version"],
  ["/owner", "owner console (passphrase)"]
];

/** The §9 three-names table, shared by the landing page and the owner console. */
export function ThreeNames(props: { name: string }) {
  return (
    <table>
      <thead><tr><th>#</th><th>Name</th><th>Who sets it</th><th>Where it shows</th></tr></thead>
      <tbody>
        <tr><td>1</td><td><b>Worker name / hostname</b></td><td>Deploy-button "Project name" (rewrites wrangler <code>name</code>), <code>wrangler.jsonc</code>, or a custom domain</td><td>the URL <code>https://&lt;name&gt;.&lt;subdomain&gt;.workers.dev/mcp</code></td></tr>
        <tr><td>2</td><td><b>Instance identity</b> (currently <code>{props.name}</code>)</td><td>this server: D1 setting (<code>set_identity</code> / owner console) → <code>MCP_SERVER_NAME</code> var when non-empty → first DNS label of the host → <code>homcp</code></td><td><code>serverInfo.name</code>, the approval page, this page, <code>whoami</code>, <code>server_info</code></td></tr>
        <tr><td>3</td><td><b>Client key</b></td><td>you: <code>claude mcp add &lt;key&gt;</code>, the <code>.mcp.json</code> key, the claude.ai connector Name, <code>codex mcp add &lt;name&gt;</code></td><td>tool names in the model's context: <code>mcp__&lt;key&gt;__&lt;tool&gt;</code></td></tr>
      </tbody>
    </table>
  );
}

/** renderLanding(catalog, scope, opts) → complete HTML document for GET /. */
export function renderLanding(catalog: ResolvedCatalog, scope: WebScope, opts: LandingOptions): string {
  const name = catalog.identity.name;
  const origin = scope.origin;
  const endpoint = mcpEndpoint(origin);
  const s = installSnippets(catalog.identity, origin);
  const counts = toolCounts(catalog);
  const budget = catalog.budget;
  const budgetText = `${budget.usedDeploy}/${budget.limit}${budget.usedClient > 0 ? ` (+${budget.usedClient} client)` : ""}`;

  const page = (
    <Layout title={`${name} — higher-order MCP server`} description={catalog.identity.description ?? `${name}: a renameable, OAuth-capable MCP server on Cloudflare Workers.`}>
      <h1 data-testid="identity-name">{name}</h1>
      <p class="sub">{catalog.identity.title ? <span>{catalog.identity.title} · </span> : null}higher-order MCP server · v{VERSION}</p>
      <div class="pills">
        <Pill label="OAuth">{opts.cimd ? "CIMD + DCR" : "DCR"}</Pill>
        <Pill label="Tools">{counts.visible} listed · {counts.defined} defined · budget {budgetText}</Pill>
        <a href="/owner" data-testid="owner-link">Owner console →</a>
      </div>
      {catalog.identity.description ? <p>{catalog.identity.description}</p> : null}
      {catalog.schemaMissing ? (
        <div class="box warn" data-testid="schema-missing">
          <b>Database not migrated yet</b> — run <code>npm run db:migrate:remote</code>. Only built-in tools are available until then; registry and memory tools answer <code>db_not_migrated</code>.
        </div>
      ) : null}

      <h2>1. Connect Claude Code <span class="muted">(user scope — every project on this machine)</span></h2>
      <Snippet testid="claude-add" text={s.claudeAdd} />
      <Snippet testid="claude-login" text={s.claudeLogin} />
      <p class="note">"{name}" becomes the tool prefix <code>mcp__{name}__…</code> — pick any short key. Later, run <code>/mcp</code> inside Claude Code to reconnect or refresh tools.</p>

      <h2>2. Connect claude.ai</h2>
      <p><a class="btn" href={s.claudeAiLink} data-testid="claudeai-link" rel="noopener">Add to claude.ai</a></p>
      <pre data-testid="claudeai-url"><code>{s.claudeAiLink}</code></pre>
      <p class="note">Manual: Customize → Connectors → Add → Add custom connector → Name <code>{name}</code>, URL <code>{endpoint}</code> → Continue (the server is probed and shown as "Detected") → Add creates it unconnected → Connect → owner passphrase → Approve. Step 2 keeps "Always required" and "Use Anthropic hosted client metadata (CIMD)" — both auto-detected.</p>
      <p class="note">Note: claude.ai refuses a URL that is already a connector in your organisation — remove the old one first. The endpoint path must be exactly <code>/mcp</code>.</p>

      <h2>3. Codex</h2>
      <Snippet testid="codex-add" text={`${s.codexAdd} && ${s.codexLogin}`} />

      <details>
        <summary>Override in one project</summary>
        <p class="note">Drop this into <code>.mcp.json</code> at the repo root (or run <code>scripts/connect-mcp.sh project {endpoint} {name}</code>):</p>
        <Snippet testid="project-mcp-json" text={s.projectMcpJson} />
        <p class="note">Same key as your user-scope entry — project scope wins; the tool prefix stays <code>mcp__{name}__</code>. Claude Code will warn "same name in more than one scope with different endpoints" — expected; sign in once per endpoint.</p>
      </details>

      <details>
        <summary>Headless / static token (optional)</summary>
        <p class="note"><code>wrangler secret put MCP_API_TOKEN</code>, then:</p>
        <Snippet testid="claude-token" text={s.claudeToken} />
        <p class="note">Never paste the token into chats; <code>whoami</code> reports <code>via:"token"</code> so transcripts can be audited.</p>
      </details>

      <details>
        <summary>Plugin install</summary>
        <Snippet testid="plugin-install" text={s.pluginInstall} />
        <p class="note">Tools appear as <code>mcp__plugin_homcp_homcp__…</code> — prefer the user-scope key for a short prefix or a per-project override. Marketplace: <code>{MARKETPLACE_REPO}</code>.</p>
      </details>

      <details>
        <summary>Rename this server — the three names</summary>
        <ThreeNames name={name} />
        <p class="note">Ask Claude: <code>set_identity {"{"}name:"new-name"{"}"}</code> — or use the <a href="/owner">owner console</a>. Renaming never touches tool names, stored data or issued tokens. Client keys and connector names keep whatever you typed. Names #2 and #3 use <code>[A-Za-z0-9_-]</code>, at most 32 characters, and every key character costs one tool-name character (<code>mcp__key__tool</code> must stay ≤ 128).</p>
      </details>

      <details>
        <summary>Endpoints</summary>
        <table>
          <tbody>
            {ENDPOINTS.map(([path, what]) => (
              <tr><td><code>{origin}{path}</code></td><td class="muted">{what}</td></tr>
            ))}
          </tbody>
        </table>
        <Snippet testid="curl-health" text={s.curlHealth} />
      </details>

      <footer>
        <p>Tools that create tools: <code>define_tool</code> → <code>call_tool</code> → <code>promote_tool</code>.</p>
        <p>{REFRESH_HINT}</p>
        <p class="muted">catalog_version {catalog.catalogVersion} · {counts.builtin} built-in tools · {counts.defined} defined · protocol 2026-07-28 + legacy lane</p>
      </footer>
    </Layout>
  );
  return renderDocument(page);
}
