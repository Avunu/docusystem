// `--refresh-catalog` (step 4 of 5.1): a live copy of avunu.net's projects.json replaces the bundled
// catalog only when WP1's `syncCatalog` says it conforms. `syncCatalog` is WP1's (a stub until it
// merges), so these tests replace it with a documented fake that behaves as its contract says: it
// writes `out` and answers `{ ok, message }` and never throws on network trouble. The real function
// is exercised against a local HTTP server by WP1's own tests; the integration check that wires the
// two together runs after both merge.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { assemble } from "../../src/lib/assemble.js";
import { CATALOG_URL, syncCatalog } from "../../src/lib/catalog.js";
import { name, version } from "../../src/lib/package-info.js";
import { SITE_SOURCE, argsFor, makeShell } from "./helpers.js";

vi.mock("../../src/lib/catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/catalog.js")>()),
  syncCatalog: vi.fn(),
}));

const fake = vi.mocked(syncCatalog);

/**
 * What the fake sync answers. The frozen contract is `{ ok, message }`; WP1's real function adds an
 * `outcome`, so the answer is typed by the function under test and works against either.
 */
const answer = (ok: boolean, message: string) =>
  ({ ok, message, outcome: ok ? "written" : "failed" }) as Awaited<ReturnType<typeof syncCatalog>>;
const LIVE = {
  version: 1,
  generated: "2026-10-07T00:00:00Z",
  site: "https://avunu.net",
  projects: [],
};

beforeEach(() => {
  fake.mockReset();
});

const run = (shell: ReturnType<typeof makeShell>, extra = {}) =>
  assemble(argsFor(shell, extra), { siteSource: SITE_SOURCE });

describe("the catalog of the root", () => {
  test("is the bundled one, and avunu.net is not asked, unless a refresh is requested", async () => {
    const shell = makeShell();
    const result = await run(shell);
    expect(fake).not.toHaveBeenCalled();
    expect(result.manifest.catalog).toBe("bundled");
    expect(result.warnings).toEqual([]);
    expect(readFileSync(join(shell.paths.root, "data", "projects.snapshot.json"))).toEqual(
      readFileSync(join(SITE_SOURCE, "data", "projects.snapshot.json")),
    );
  });

  test("a live copy that sync accepts replaces the bundled one and is recorded as generated", async () => {
    fake.mockImplementation(async ({ out }) => {
      writeFileSync(out, JSON.stringify(LIVE));
      return answer(true, "fetched 0 projects");
    });
    const shell = makeShell();
    const result = await run(shell, { refreshCatalog: true });

    const snapshot = join(shell.paths.root, "data", "projects.snapshot.json");
    expect(JSON.parse(readFileSync(snapshot, "utf8"))).toEqual(LIVE);
    expect(result.manifest.catalog).toBe("live");
    expect(result.manifest.files["data/projects.snapshot.json"]).toBe("generated");
    expect(result.warnings).toEqual([]);
    expect(readdirSync(join(shell.paths.root, "data"))).toEqual(["projects.snapshot.json"]);
    expect(JSON.parse(readFileSync(shell.paths.manifest, "utf8")).catalog).toBe("live");
    // The call: 5 seconds, written next to the snapshot (never over the bundled copy until accepted).
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake).toHaveBeenCalledWith({
      url: CATALOG_URL,
      out: `${snapshot}.live`,
      timeoutMs: 5000,
    });
  });

  test.each([
    [
      "an explicit catalogUrl",
      { catalogUrl: "http://127.0.0.1:1/a.json" },
      "http://127.0.0.1:1/a.json",
    ],
    [
      "DOCUSYSTEM_CATALOG_URL",
      { env: { DOCUSYSTEM_CATALOG_URL: "http://127.0.0.1:2/b.json" } },
      "http://127.0.0.1:2/b.json",
    ],
    [
      "catalogUrl before the environment",
      {
        catalogUrl: "http://127.0.0.1:1/a.json",
        env: { DOCUSYSTEM_CATALOG_URL: "http://127.0.0.1:2/b.json" },
      },
      "http://127.0.0.1:1/a.json",
    ],
    ["nothing: avunu.net", {}, CATALOG_URL],
  ])("fetches from %s", async (_what, extra, url) => {
    fake.mockResolvedValue(answer(false, "unreachable"));
    await run(makeShell(), { refreshCatalog: true, ...extra });
    expect(fake.mock.calls[0]?.[0].url).toBe(url);
  });

  test("a refusal keeps the bundled copy and says why, with the catalog: prefix", async () => {
    fake.mockImplementation(async ({ out }) => {
      // Even a file that a misbehaving sync left behind is not taken.
      writeFileSync(out, "{}");
      return answer(false, "the live catalog is version 2, not 1");
    });
    const shell = makeShell();
    const result = await run(shell, { refreshCatalog: true });

    expect(result.manifest.catalog).toBe("bundled");
    expect(result.manifest.files["data/projects.snapshot.json"]).toBe("package");
    expect(result.warnings).toEqual([
      `catalog: the live catalog is version 2, not 1; using the catalog bundled with ${name} ${version}`,
    ]);
    expect(result.errors).toEqual([]);
    expect(readFileSync(join(shell.paths.root, "data", "projects.snapshot.json"))).toEqual(
      readFileSync(join(SITE_SOURCE, "data", "projects.snapshot.json")),
    );
    expect(existsSync(join(shell.paths.root, "data", "projects.snapshot.json.live"))).toBe(false);
    expect(JSON.parse(readFileSync(shell.paths.manifest, "utf8")).warnings).toEqual(
      result.warnings,
    );
  });

  test("a reason that runs over several lines keeps the consequence on its first line", async () => {
    fake.mockResolvedValue(
      answer(
        false,
        "https://avunu.net/projects.json does not match the catalog contract:\n  - version must be 1\n  - projects[0].slug is missing",
      ),
    );
    const result = await run(makeShell(), { refreshCatalog: true });
    expect(result.warnings).toEqual([
      `catalog: https://avunu.net/projects.json does not match the catalog contract; using the catalog bundled with ${name} ${version}\n  - version must be 1\n  - projects[0].slug is missing`,
    ]);
  });

  test("a sync that throws is a warning, not a failed build", async () => {
    fake.mockRejectedValue(new Error("not implemented (WP1)"));
    const result = await run(makeShell(), { refreshCatalog: true });
    expect(result.manifest.catalog).toBe("bundled");
    expect(result.warnings).toEqual([
      `catalog: not implemented (WP1); using the catalog bundled with ${name} ${version}`,
    ]);
  });
});
