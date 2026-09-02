#!/usr/bin/env node
// scripts/check-names.mjs — §16.5 grep guard, first step of `npm run check`.
// Deployment names must never be baked into the source: the template is renamed per deploy (docs/NAMES.md) and an
// earlier template shipped ~40 hard-coded sites. Scans src/** (or the directories given as arguments) for the
// case-insensitive literals below and fails with file:line on any hit. The product name `homcp` is allowed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ["src"];
const LITERALS = [
  { label: "arra", re: /\barra\b/i },              // word-bounded so `array`/`Array` never trips it; `arra-memory` still does
  { label: "thor-memory", re: /thor-memory/i },
  { label: "odin-memory", re: /odin-memory/i },
  { label: "buildwithoracle", re: /buildwithoracle/i },
  { label: "laris.workers.dev", re: /laris\.workers\.dev/i }
];
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist"]);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|jsonc|sql|md|txt|html|css|sh|yml|yaml|toml)$/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile() && TEXT.test(name)) yield p;
  }
}

const hits = [];
let files = 0;
for (const d of dirs) {
  const abs = join(ROOT, d);
  let st;
  try { st = statSync(abs); } catch { console.error(`[check-names] no such directory: ${d}`); process.exit(2); }
  if (!st.isDirectory()) { console.error(`[check-names] not a directory: ${d}`); process.exit(2); }
  for (const file of walk(abs)) {
    files++;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { label, re } of LITERALS) {
        if (re.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: contains "${label}"`);
      }
    });
  }
}

if (hits.length) {
  console.error(`[check-names] FAIL: deployment names found in ${dirs.join(", ")} (${hits.length} hit${hits.length === 1 ? "" : "s"}):`);
  for (const h of hits) console.error(`  ${h}`);
  console.error("[check-names] the source must stay deployment-agnostic; move the name to a var, a setting or docs/.");
  process.exit(1);
}
console.log(`[check-names] ok: no deployment names in ${dirs.map((d) => `${d}/`).join(", ")} (${files} files)`);
