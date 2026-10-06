import { defineConfig } from "vitest/config";

// The end-to-end tests of the scripts and the example (owned by the end-to-end work package). They are not
// part of `npm test`: they spawn the scripts, pack a stand-in package and run npm and git, which takes a
// while. Run them with
//
//   npx vitest run --config test/e2e/vitest.config.ts
//
// from the repository root. The tests that need a real packed package (the consumer matrix) are not
// vitest tests at all: scripts/test-pack.mjs is that test, and CI runs it per row.
export default defineConfig({
  test: {
    name: "e2e",
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    exclude: ["**/node_modules/**", "test/**/fixtures/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
