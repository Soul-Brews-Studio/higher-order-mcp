// vitest.config.ts (excluded from tsc)
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, OWNER_PASSPHRASE: "test-passphrase", MCP_API_TOKEN: "test-static-token", MCP_SERVER_NAME: "homcp-test", HOMCP_SECRET_X: "s3cret" } }
    })],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] }
  };
});
