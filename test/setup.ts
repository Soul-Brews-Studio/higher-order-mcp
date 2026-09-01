import { applyD1Migrations, env } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    OAUTH_KV: KVNamespace;
    TEST_MIGRATIONS: D1Migration[];
    MCP_SERVER_NAME: string;
    OWNER_PASSPHRASE: string;
    MCP_API_TOKEN: string;
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
