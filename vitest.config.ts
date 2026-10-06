import { defineConfig } from "vitest/config";

// Two projects, both run by `npm test`:
//   unit         everything under test/ except the two folders below; no network, fast.
//   integration  test/integration/**: runs the real pinned Jx on fixture projects (slow).
// test/e2e/** is not part of `npm test`: scripts/test-pack.mjs drives it against the packed tarball.
// Fixture trees (test/**/fixtures) hold files, not tests, whatever they are called.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: [
            "**/node_modules/**",
            "test/integration/**",
            "test/e2e/**",
            "test/**/fixtures/**",
          ],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["test/integration/**/*.test.ts"],
          exclude: ["**/node_modules/**", "test/**/fixtures/**"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
