import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@jira-triage/shared-types": path.resolve(__dirname, "packages/shared-types/src/index.ts"),
      "@jira-triage/anthropic-client": path.resolve(
        __dirname,
        "packages/anthropic-client/src/index.ts",
      ),
      "@jira-triage/classifier": path.resolve(__dirname, "apps/classifier/src/index.ts"),
      "@jira-triage/research": path.resolve(__dirname, "apps/research/src/index.ts"),
    },
  },
});
