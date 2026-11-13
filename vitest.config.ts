import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      projects: [
        {
          test: { name: "unit", include: ["tests/*.test.ts"], environment: "node" },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  ENVIRONMENT: "test",
                  ACCESS_TEAM_DOMAIN: "talo-test.cloudflareaccess.com",
                  ACCESS_AUD: "test-audience",
                  ADMIN_EMAILS: "admin@talo.example, Second@Talo.example",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["tests/worker/**/*.test.ts"],
            setupFiles: ["tests/worker/setup.ts"],
          },
        },
      ],
    },
  };
});
