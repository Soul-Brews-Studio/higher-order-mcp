#!/usr/bin/env node
// Deploy = `wrangler deploy` (auto-provisions OAUTH_KV / DB from id-less bindings, linked by binding name)
//        + `wrangler d1 migrations apply DB --remote` (by BINDING). Deploy first: a fresh checkout has no database until deploy provisions it.
// The Worker tolerates the seconds in between (built-in tools only, /health schema:"missing"). No name assertions: renaming must never fail here.
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const passthrough = args.filter((a) => a !== "--dry-run");
function wrangler(cmd) {
  const r = spawnSync("npx", ["wrangler", ...cmd], { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  if (r.error) { console.error(`[deploy] could not start wrangler: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (dryRun) { console.log("[deploy] dry run (no migrations)"); wrangler(["deploy", "--dry-run", ...passthrough]); process.exit(0); }
console.log("[deploy] 1/2 wrangler deploy");
wrangler(["deploy", ...passthrough]);
console.log("[deploy] 2/2 wrangler d1 migrations apply DB --remote");
wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
console.log("\n[deploy] done. Open your Worker URL: the landing page prints the exact `claude mcp add` / claude.ai steps for this deploy.");
console.log("[deploy] note: wrangler may write resource ids into wrangler.jsonc on an interactive first deploy — keep them out of the template repo.");
