// src/util/json-path.ts [C] — tiny dotted-path accessor shared by the template language, the http kind's
// `json_path` and compose step references. Grammar: `a.b[0].c`, `a["key"]`, `[1]`; optional leading `$` / `$.`.
// Never throws on missing data (returns undefined); throws only on a malformed path.

export type PathSegment = string | number;

const IDENT = /^[A-Za-z0-9_$-]+/;

export class JsonPathError extends Error {
  constructor(path: string, reason: string) {
    super(`invalid path '${path}': ${reason}`);
    this.name = "JsonPathError";
  }
}

/** Parses `a.b[0].c` into `["a", "b", 0, "c"]`. Empty path → []. */
export function parsePath(path: string): PathSegment[] {
  let s = path.trim();
  if (s === "" || s === "$") return [];
  if (s.startsWith("$.")) s = s.slice(2);
  else if (s.startsWith("$[")) s = s.slice(1);
  const segs: PathSegment[] = [];
  let i = 0;
  let expectDot = false;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === ".") {
      if (!expectDot) throw new JsonPathError(path, `unexpected '.' at ${i}`);
      i++;
      expectDot = false;
      continue;
    }
    if (ch === "[") {
      const close = s.indexOf("]", i);
      if (close < 0) throw new JsonPathError(path, `unterminated '[' at ${i}`);
      const inner = s.slice(i + 1, close).trim();
      if (/^-?\d+$/.test(inner)) segs.push(Number.parseInt(inner, 10));
      else if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) segs.push(inner.slice(1, -1));
      else throw new JsonPathError(path, `bad index '${inner}'`);
      i = close + 1;
      expectDot = true;
      continue;
    }
    if (expectDot) throw new JsonPathError(path, `expected '.' or '[' at ${i}`);
    const m = IDENT.exec(s.slice(i));
    if (!m) throw new JsonPathError(path, `unexpected character '${ch}' at ${i}`);
    segs.push(m[0]);
    i += m[0].length;
    expectDot = true;
  }
  return segs;
}

/** Walks `segs` through `obj`; undefined when any hop is missing. Arrays accept negative indexes from the end. */
export function getSegments(obj: unknown, segs: readonly PathSegment[]): unknown {
  let cur: unknown = obj;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      const idx = seg < 0 ? cur.length + seg : seg;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    if (seg === "__proto__" || seg === "constructor" || seg === "prototype") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** `get(obj, "a.b[0].c")`. Throws JsonPathError on a malformed path; undefined when data is missing. */
export function get(obj: unknown, path: string): unknown {
  return getSegments(obj, parsePath(path));
}
