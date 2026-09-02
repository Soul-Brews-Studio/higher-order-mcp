// src/mcp/result.ts [W0] — the one way tools build results. Tools never throw; they return ok()/fail().
// Error contract (§12.5): { isError:true, content:[{type:"text", text:"<code>: <message>\n<hint>"}], structuredContent:{ error:{ code, message, hint?, details? } } }
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ErrorCode, ToolErrorBody } from "../types";

/** §14 verbatim. Appended to every mutation result and to server_info / /api/info. */
export const REFRESH_HINT =
  `Clients cache the tool list. Claude Code: run /mcp and reconnect this server (or wait for the list_changed stream). claude.ai: connector menu → "Refresh tools list", then start a new chat. list_tools always shows the current catalog and call_tool can run any enabled tool without a refresh.`;

/** Text results are truncated at 100 000 chars (§14). */
export const MAX_TEXT = 100_000;

export function truncate(text: string, max: number = MAX_TEXT): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}\n…[truncated ${dropped} chars]`;
}

export function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: truncate(text) }],
    ...(structured !== undefined ? { structuredContent: structured } : {})
  };
}

export function fail(code: ErrorCode, message: string, hint?: string, details?: unknown): CallToolResult {
  const body: ToolErrorBody = {
    error: { code, message, ...(hint !== undefined ? { hint } : {}), ...(details !== undefined ? { details } : {}) }
  };
  return {
    isError: true,
    content: [{ type: "text", text: truncate(hint ? `${code}: ${message}\n${hint}` : `${code}: ${message}`) }],
    structuredContent: body as unknown as Record<string, unknown>
  };
}

/** Appends REFRESH_HINT to the text and mirrors it as structuredContent.refreshHint. Never mutates the input. */
export function withRefreshHint(r: CallToolResult): CallToolResult {
  const content = [...(r.content ?? [])];
  const idx = content.findIndex((c) => c.type === "text");
  if (idx >= 0) {
    const block = content[idx] as { type: "text"; text: string };
    content[idx] = { ...block, text: `${block.text}\n\n${REFRESH_HINT}` };
  } else {
    content.push({ type: "text", text: REFRESH_HINT });
  }
  const structured = (r.structuredContent ?? {}) as Record<string, unknown>;
  return { ...r, content, structuredContent: { ...structured, refreshHint: REFRESH_HINT } };
}

/** Whether a result carries the §12.5 error contract (isError + structuredContent.error.code). */
export function isFail(r: CallToolResult): r is CallToolResult & { isError: true; structuredContent: ToolErrorBody } {
  const err = (r.structuredContent as Partial<ToolErrorBody> | undefined)?.error;
  return r.isError === true && typeof err?.code === "string";
}
