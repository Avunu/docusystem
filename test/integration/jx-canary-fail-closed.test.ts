// The answer to "Jx wording changes make strictness fail open" (section 9.2): even when the readers of
// Jx's output find nothing (as they would after Jx rewords every message), a strict build of a tree
// with a broken link still fails, because the generated `links: "error"` makes Jx itself exit non-zero.
// The two readers are replaced by functions that find nothing; the Jx run, the exit code and the
// classification are real.
import { existsSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { runPipelineWith } from "../../src/lib/pipeline.js";
import { jxDeps, jxEnv, repoFrom } from "./support.js";

vi.mock("../../src/lib/strict.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/strict.js")>();
  return { ...real, problemsIn: () => [], failureProblems: () => [] };
});

describe("with the readers of Jx's output blind", () => {
  test("a broken link still fails a strict build, and passes a lenient one", async () => {
    const strictRepo = repoFrom("canary/broken");
    const lines: string[] = [];
    const strict = await runPipelineWith(
      {
        cwd: strictRepo.dir,
        env: jxEnv(),
        strict: true,
        log: (l) => lines.push(l),
        error: (l) => lines.push(l),
      },
      jxDeps(strictRepo),
    );
    expect(strict.ok).toBe(false);
    expect(existsSync(strictRepo.paths.dist)).toBe(false);
    expect(lines.some((line) => line.startsWith("docusystem: jx build failed."))).toBe(true);
    expect(lines.some((line) => line.includes('"README.md" links to "guide/missing.md"'))).toBe(
      true,
    );

    const lenientRepo = repoFrom("canary/broken");
    const lenient = await runPipelineWith(
      { cwd: lenientRepo.dir, env: jxEnv(), lenient: true, log: () => {}, error: () => {} },
      jxDeps(lenientRepo),
    );
    // Blind readers find no problems to downgrade; the build still publishes.
    expect(lenient.ok).toBe(true);
    expect(lenient.problems).toEqual([]);
  });
});
