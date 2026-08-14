import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest rather than node:test here: these tests import through the `@/` alias
 * and extensionless relative paths, which is how the app code is written and
 * what Next resolves. Node's own runner requires explicit `.ts` extensions,
 * which would mean writing the tests differently from everything they test.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
