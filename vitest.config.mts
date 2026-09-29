import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, ".") } },
  // Database tests migrate an in-memory Postgres once per file; under parallel load that
  // first setup can take longer than the 10 s default.
  test: { include: ["tests/**/*.test.ts"], environment: "node", hookTimeout: 60_000, testTimeout: 30_000 },
});
