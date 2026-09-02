// src/web/layout.tsx [E] — the shared HTML shell for every human-facing page (landing, owner console; A's consent page may reuse it).
// No external assets: one inline <style>, no scripts, no fonts, so the pages work under the strict CSP below.
import type { PropsWithChildren } from "hono/jsx";
import type { HtmlEscapedString } from "hono/utils/html";

/** Response headers for every HTML page (§13): no scripts, no framing, no caching, no referrer. No `form-action` on purpose. */
export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

/** Renders a JSX tree (synchronous components only) into a complete HTML document. */
export function renderDocument(node: HtmlEscapedString | Promise<HtmlEscapedString>): string {
  return `<!doctype html>\n${String(node)}`;
}

/** Wraps a rendered document in a Response with PAGE_HEADERS. */
export function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...headers } });
}

export const CSS = `
:root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5b6270; --bg: #fafafa; --card: #ffffff; --line: #e2e5ea; --accent: #b45309; --ok: #15803d; --warn-bg: #fef9c3; --warn-line: #ca8a04; --danger: #b91c1c; --code-bg: #f1f3f6; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8e8; --muted: #a0a7b4; --bg: #121417; --card: #1b1e23; --line: #2c313a; --accent: #f59e0b; --ok: #4ade80; --warn-bg: #3b2f00; --warn-line: #eab308; --danger: #f87171; --code-bg: #0f1114; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 30px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 19px; margin: 32px 0 8px; }
h3 { font-size: 16px; margin: 20px 0 6px; }
p { margin: 8px 0; }
.sub { color: var(--muted); margin: 0 0 16px; }
.pills { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0 20px; }
.pill { display: inline-block; border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: 3px 12px; font-size: 13px; color: var(--muted); }
.pill b { color: var(--fg); font-weight: 600; }
a { color: var(--accent); }
.btn { display: inline-block; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; font-size: 14px; cursor: pointer; }
.btn.secondary { background: transparent; color: var(--accent); }
.btn.danger { background: transparent; border-color: var(--danger); color: var(--danger); }
.btn.small { padding: 4px 10px; font-size: 13px; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; margin: 8px 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code-bg); padding: 1px 5px; border-radius: 4px; }
pre code { background: none; padding: 0; }
.note { color: var(--muted); font-size: 14px; }
.box { border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
.warn { border-color: var(--warn-line); background: var(--warn-bg); color: var(--fg); }
.error { border-color: var(--danger); }
.ok { color: var(--ok); }
details { border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 10px 16px; margin: 10px 0; }
summary { cursor: pointer; font-weight: 600; }
table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 8px 0; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 13px; }
.muted { color: var(--muted); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.actions form { margin: 0; }
form.stack label { display: block; margin: 10px 0 4px; font-weight: 600; font-size: 14px; }
input[type=text], input[type=password], textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
textarea { min-height: 80px; }
.tabs { display: flex; gap: 14px; flex-wrap: wrap; margin: 12px 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
.tabs a { text-decoration: none; font-weight: 600; }
.bar { height: 8px; background: var(--code-bg); border-radius: 999px; overflow: hidden; border: 1px solid var(--line); }
.bar span { display: block; height: 100%; background: var(--accent); }
footer { margin-top: 40px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 14px; }
`;

export interface LayoutProps { title: string; description?: string }

/** The document shell: head with the inline stylesheet, body with a centred column. */
export function Layout(props: PropsWithChildren<LayoutProps>) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <meta name="robots" content="noindex" />
        {props.description ? <meta name="description" content={props.description} /> : null}
        <title>{props.title}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <main class="wrap">{props.children}</main>
      </body>
    </html>
  );
}

/** A copy-paste block. `testid` lands on the <pre> as data-testid so QA and docs can find it. */
export function Snippet(props: { testid: string; text: string }) {
  return (
    <pre data-testid={props.testid}><code>{props.text}</code></pre>
  );
}

export function Pill(props: PropsWithChildren<{ label: string }>) {
  return (
    <span class="pill">{props.label}: <b>{props.children}</b></span>
  );
}
