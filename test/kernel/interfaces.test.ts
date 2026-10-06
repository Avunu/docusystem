// Appendix B of the architecture decision record freezes the names every work package exports to the
// others. This test fails the moment one is renamed, moved to another file or removed, which is the
// change the work packages must not make on their own: it breaks the packages that import it.
// (Signatures are checked by the compiler, not here.)
import { describe, expect, test } from "vitest";

const FROZEN: Record<string, string[]> = {
  "lib/types.js": [],
  "lib/platforms.js": ["PLATFORMS"],
  "lib/package-info.js": [
    "name",
    "version",
    "major",
    "packageRoot",
    "REPOSITORY",
    "NODE_FLOOR",
    "WORKFLOW_CONTRACT",
  ],
  "lib/fsutil.js": ["walkFiles", "copyFile", "writeJson", "removeInside", "replaceDir", "sha256"],
  "lib/config.js": [
    "CONFIG_FILE",
    "ConfigError",
    "validateConfig",
    "readConfig",
    "findSiteDir",
    "findRepoRoot",
    "resolveBranch",
    "pathsFor",
  ],
  "lib/catalog.js": [
    "CATALOG_URL",
    "validateCatalog",
    "readBundledCatalog",
    "bundledCatalogFile",
    "syncCatalog",
    "entryFor",
  ],
  "lib/preflight.js": ["checkSlug", "preflight"],
  "lib/assemble.js": ["assemble"],
  "lib/project.js": ["readBaseProject", "knownTokens", "mergeJx", "generateProject"],
  "lib/overrides.js": ["ejectFile", "overrideFindings"],
  "lib/jx.js": ["JX_PACKAGES", "packageDir", "jxCli", "jxVersions", "linkJxPackages"],
  "lib/lock.js": ["LockError", "acquireLock"],
  "lib/stage.js": ["stageSite"],
  "lib/lint.js": ["lintDocs", "formatIssue"],
  "lib/docs.js": ["readDocs", "isExcluded", "isPublished", "urlFor"],
  "lib/nav.js": ["buildNav", "writeNav"],
  "lib/postbuild.js": ["runPostbuild"],
  "lib/assert.js": ["assertBuild"],
  "lib/links.js": ["checkLinks", "formatIssues"],
  "lib/contrast.js": ["contrastFailures", "highlightOf"],
  "lib/strict.js": ["PROBLEM", "problemsIn", "doneRoutes", "isStrict", "expectedRoutes"],
  "lib/pipeline.js": ["runPipeline"],
  "lib/ci.js": ["annotation"],
  "lib/gitremote.js": ["normalizeRemote"],
  "lib/dependabot.js": ["ensureDependabotEntries"],
  "lib/automerge.js": ["patchAutoMerge"],
  "lib/pin.js": ["resolveWorkflowPin", "repinWorkflow"],
  "lib/workflows.js": ["renderScaffold"],
  "commands/init.js": ["run", "decide"],
  "commands/upgrade.js": ["run"],
  "commands/doctor.js": ["run", "diagnose"],
  "commands/eject.js": ["run"],
  "commands/build.js": ["run"],
  "commands/check.js": ["run"],
  "commands/lint.js": ["run"],
  "commands/links.js": ["run"],
  "commands/info.js": ["run"],
  "commands/jx.js": ["run"],
  "commands/dev.js": ["run"],
};

// Modules that no other package imports by name: they only have to exist.
const EXIST = [
  "lib/repo-links.js",
  "lib/markdown.js",
  "lib/frontmatter.js",
  "lib/slug.js",
  "lib/tidy.js",
  "lib/devserver.js",
  "commands/types.js",
];

describe("Appendix B", () => {
  for (const [file, names] of Object.entries(FROZEN)) {
    test(`${file} exports ${names.join(", ") || "its types"}`, async () => {
      const module = (await import(/* @vite-ignore */ `../../src/${file}`)) as Record<
        string,
        unknown
      >;
      for (const exported of names) {
        expect(module, `${file} ${exported}`).toHaveProperty(exported);
        expect(module[exported], `${file} ${exported}`).not.toBeUndefined();
      }
    });
  }

  test("the modules without a frozen name are there", async () => {
    for (const file of EXIST) {
      await expect(import(/* @vite-ignore */ `../../src/${file}`), file).resolves.toBeTypeOf(
        "object",
      );
    }
  });
});
