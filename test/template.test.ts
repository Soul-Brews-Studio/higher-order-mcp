// test/template.test.ts [C] — §18: the template language (src/util/template.ts) and json-path, unit level.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { render, renderValue, evaluate, TemplateError, contextFor, secretRefs, inputRefs, stepRefs, nowParts, type RenderContext } from "../src/util/template";
import { get, parsePath, JsonPathError } from "../src/util/json-path";
import type { Identity, Principal, RequestScope, ResolvedCatalog } from "../src/types";

const identity: Identity = { name: "homcp-test", title: "Homcp Test", instructions: "", source: "var" };
const principal: Principal = { userId: "owner", via: "token", clientKey: "token", scopes: [] };
function ctx(input: Record<string, unknown> = {}, steps: RenderContext["steps"] = {}): RenderContext {
  return { input, steps, identity, principal, now: { iso: "2026-09-02T10:00:00.000Z", date: "2026-09-02" }, secret: (n) => (n === "X" ? "s3cret" : undefined) };
}

describe("json-path", () => {
  it("parses dotted paths, indexes and quoted keys", () => {
    expect(parsePath("a.b[0].c")).toEqual(["a", "b", 0, "c"]);
    expect(parsePath('$.items["x-y"][2]')).toEqual(["items", "x-y", 2]);
    expect(parsePath("")).toEqual([]);
    expect(parsePath("$")).toEqual([]);
    expect(parsePath("[1].name")).toEqual([1, "name"]);
  });
  it("walks data and returns undefined when missing", () => {
    const o = { a: { b: [{ c: 7 }] }, list: [1, 2, 3] };
    expect(get(o, "a.b[0].c")).toBe(7);
    expect(get(o, "list[-1]")).toBe(3);
    expect(get(o, "a.z.q")).toBeUndefined();
    expect(get(o, "a.b[5].c")).toBeUndefined();
    expect(get(null, "a")).toBeUndefined();
    expect(get({ constructor: 1 }, "constructor")).toBeUndefined();
  });
  it("rejects malformed paths", () => {
    expect(() => parsePath("a..b")).toThrow(JsonPathError);
    expect(() => parsePath("a[")).toThrow(JsonPathError);
    expect(() => parsePath("a[b]")).toThrow(JsonPathError);
    expect(() => parsePath("a b")).toThrow(JsonPathError);
  });
});

describe("render", () => {
  it("{{input.x}} stringifies scalars and objects", () => {
    expect(render("hi {{input.x}}!", ctx({ x: "Nat" }))).toBe("hi Nat!");
    expect(render("n={{input.n}} b={{ input.b }}", ctx({ n: 3, b: false }))).toBe("n=3 b=false");
    expect(render("o={{input.o}}", ctx({ o: { a: [1] } }))).toBe('o={"a":[1]}');
    expect(render("deep={{input.o.a[0].b}}", ctx({ o: { a: [{ b: "x" }] } }))).toBe("deep=x");
  });
  it("{{json input.o}} emits JSON", () => {
    expect(render("{{json input.o}}", ctx({ o: { a: "b" } }))).toBe('{"a":"b"}');
    expect(render("{{json input.s}}", ctx({ s: 'q"uote' }))).toBe('"q\\"uote"');
  });
  it("missing values render empty and warn", () => {
    const warnings: string[] = [];
    expect(render("[{{input.missing}}]", ctx({}), { warnings })).toBe("[]");
    expect(warnings).toEqual(["{{input.missing}} is empty"]);
    const dry: string[] = [];
    render("[{{input.missing}}] {{steps.s1.text}}", ctx({}), { warnings: dry, dry: true });
    expect(dry).toEqual([]);
    expect(render("{{json input.missing}}", ctx({}))).toBe("null");
  });
  it("steps.<id>.text|structured[.path]|isError", () => {
    const steps = { s1: { text: "hello", structured: { a: [{ b: "deep" }], id: "m-1" }, isError: false } };
    expect(render("{{steps.s1.text}}", ctx({}, steps))).toBe("hello");
    expect(render("{{steps.s1.structured.a[0].b}}", ctx({}, steps))).toBe("deep");
    expect(render("{{steps.s1.structured.id}}", ctx({}, steps))).toBe("m-1");
    expect(render("{{steps.s1.isError}}", ctx({}, steps))).toBe("false");
    expect(() => render("{{steps.s1.nope}}", ctx({}, steps))).toThrow(TemplateError);
  });
  it("principal, identity and now", () => {
    expect(render("{{principal.clientKey}}/{{identity.name}}/{{now.date}}", ctx())).toBe("token/homcp-test/2026-09-02");
    expect(render("{{now.iso}}", ctx())).toBe("2026-09-02T10:00:00.000Z");
    expect(() => render("{{principal.scopes}}", ctx())).toThrow(TemplateError);
    expect(() => render("{{identity.instructions}}", ctx())).toThrow(TemplateError);
    expect(() => render("{{now.epoch}}", ctx())).toThrow(TemplateError);
  });
  it("unknown root throws spec_invalid", () => {
    expect(() => render("{{env.SECRET}}", ctx())).toThrow(TemplateError);
    expect(() => render("{{process.env}}", ctx())).toThrow(TemplateError);
    expect(() => render("{{}}", ctx())).toThrow(TemplateError);
    try { render("{{nope.x}}", ctx()); } catch (e) { expect((e as TemplateError).code).toBe("spec_invalid"); }
  });
  it("{{secret:X}} is refused without allowSecret and resolved with it", () => {
    expect(() => render("k={{secret:X}}", ctx())).toThrow(TemplateError);
    expect(render("k={{secret:X}}", ctx(), { allowSecret: true })).toBe("k=s3cret");
    expect(() => render("{{secret:NOPE}}", ctx(), { allowSecret: true })).toThrow(/not set/);
    expect(() => render("{{secret:lower}}", ctx(), { allowSecret: true })).toThrow(TemplateError);
    expect(() => renderValue({ a: "{{secret:X}}" }, ctx())).toThrow(TemplateError);
    expect(renderValue({ a: "{{= secret:X}}" }, ctx(), { allowSecret: true })).toEqual({ a: "s3cret" });
  });
  it("leaves text without tags untouched", () => {
    expect(render("plain { text } with }} and {{", ctx())).toBe("plain { text } with }} and {{");
  });
});

describe("renderValue", () => {
  it("whole-string {{= expr}} yields the raw typed value", () => {
    const c = ctx({ n: 42, list: [1, 2], obj: { k: true }, s: "str" });
    expect(renderValue("{{= input.n}}", c)).toBe(42);
    expect(renderValue("{{=input.list}}", c)).toEqual([1, 2]);
    expect(renderValue("  {{= input.obj }}  ", c)).toEqual({ k: true });
    expect(renderValue("{{= input.s}}", c)).toBe("str");
    expect(renderValue("n={{= input.n}}", c)).toBe("n=42");                      // not whole-string → text
    expect(renderValue("{{= input.missing}}", c)).toBeUndefined();
  });
  it("recurses through objects and arrays and drops undefined", () => {
    const c = ctx({ n: 1, s: "x" });
    expect(renderValue({ a: "{{input.s}}", b: ["{{= input.n}}", "{{input.s}}!"], c: 5, d: null, e: "{{= input.missing}}" }, c)).toEqual({ a: "x", b: [1, "x!"], c: 5, d: null });
  });
});

describe("helpers", () => {
  it("collects secret, input and step references", () => {
    const v = { url: "https://x/{{input.a}}?k={{secret:X}}", h: { t: "{{ secret:Y }}", i: "{{json input.b.c}}", s: "{{steps.s1.text}}" } };
    expect(secretRefs(v).sort()).toEqual(["X", "Y"]);
    expect(inputRefs(v).sort()).toEqual(["a", "b"]);
    expect(stepRefs(v)).toEqual(["s1"]);
  });
  it("nowParts and contextFor read env secrets", () => {
    const parts = nowParts(new Date("2026-01-02T03:04:05.000Z"));
    expect(parts).toEqual({ iso: "2026-01-02T03:04:05.000Z", date: "2026-01-02" });
    const scope = { env, principal } as unknown as RequestScope;
    const catalog = { identity } as unknown as ResolvedCatalog;
    const c = contextFor(scope, catalog, { q: 1 });
    expect(c.secret?.("X")).toBe("s3cret");
    expect(c.secret?.("MISSING")).toBeUndefined();
    expect(evaluate("input.q", c)).toEqual({ value: 1, missing: false, kind: "input" });
    expect(render("{{secret:X}}", c, { allowSecret: true })).toBe("s3cret");
  });
});
