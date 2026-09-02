// test/setup.ts — runs inside the Workers isolate before every test file: applies the D1 migrations
// that vitest.config.ts read from ./migrations into the TEST_MIGRATIONS binding.
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";

// @cloudflare/vitest-pool-workers 0.22.0 types `env` as `Cloudflare.Env` (the augmentable namespace from
// @cloudflare/workers-types); the older `ProvidedEnv` interface no longer exists, so the bindings are declared here.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      OAUTH_KV: KVNamespace;
      TEST_MIGRATIONS: D1Migration[];
      MCP_SERVER_NAME: string;
      OWNER_PASSPHRASE: string;
      MCP_API_TOKEN: string;
      HOMCP_SECRET_X: string;
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
