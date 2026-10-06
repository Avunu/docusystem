// Runs every browser suite against sites built from the PACKED package (section 9.5 of the architecture
// record), and writes the screenshots a person looks at.
//
//   bun run.ts --tarball <file> [--out <dir>] [--only axe,csp,drawer,fences,shots,states,switcher,edge] [--keep]
//
//   --tarball  the packed package (`npm pack`)
//   --out      where the sandboxes and the screenshots go (kept afterwards); default: a temporary folder,
//              removed at the end unless --keep
//   --only     run only these suites (comma separated); default: all
//   --keep     keep the temporary folder and print where it is
//
// The suites, and the site each one runs on:
//   axe, csp, drawer, fences, shots, states   a copy of examples/basic built with `docusystem check`
//   switcher                             a copy of the example whose slug is a real catalog slug, so that
//                                        the "You are here" state exists
//   edge                                 the edge-case adopter of fixtures/ (a README that starts with a
//                                        comment and a badge, links written from the repository root, a
//                                        page with template-looking text, folder pages), adopted with init
// The screenshots (every page at 1440, 768 and 390 pixels in both colour schemes, and the interactive
// states) are written to <out>/shots, to be uploaded as the artifact `verify-shots`: they are for a person to
// look at, nothing is compared. Exit codes: 0 every suite passed; 1 a suite failed; 2 usage error.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const SUITES = ["axe", "csp", "drawer", "fences", "shots", "states", "switcher", "edge"] as const;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    tarball: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    keep: { type: "boolean" },
  },
});
if (!values.tarball) {
  console.error(
    "usage: bun run.ts --tarball <file> [--out <dir>] [--only axe,csp,drawer,fences,shots,states,switcher,edge] [--keep]",
  );
  process.exit(2);
}
const tarball = resolve(values.tarball);
if (!existsSync(tarball)) {
  console.error(`run: ${tarball} does not exist`);
  process.exit(2);
}
const wanted = new Set<string>(values.only ? values.only.split(",").map((s) => s.trim()) : SUITES);
for (const name of wanted) {
  if (!(SUITES as readonly string[]).includes(name)) {
    console.error(`run: unknown suite ${name}; the suites are ${SUITES.join(", ")}`);
    process.exit(2);
  }
}
const here = import.meta.dirname;
const out = values.out ? resolve(values.out) : mkdtempSync(join(tmpdir(), "docusystem-verify-"));
mkdirSync(out, { recursive: true });
const shots = join(out, "shots");

// a build that must not depend on how this machine is set up
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
for (const name of [
  "DOCUSYSTEM_WORKFLOW_CONTRACT",
  "DOCUSYSTEM_LENIENT",
  "DOCUSYSTEM_BRANCH",
  "DOCUSYSTEM_CATALOG_URL",
  "GITHUB_ACTIONS",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_OUTPUT",
]) {
  delete env[name];
}

const results: Array<{ name: string; ok: boolean }> = [];
const bun = (args: string[], name: string): boolean => {
  console.log(`\n=== ${name}: bun ${args.join(" ")}`);
  const ok = spawnSync("bun", args, { cwd: here, stdio: "inherit", env }).status === 0;
  results.push({ name, ok });
  return ok;
};
const scaffold = (sandbox: string, ...args: string[]): boolean => {
  console.log(`\n=== scaffold ${sandbox}`);
  const ok =
    spawnSync(
      "bun",
      ["scaffold.ts", "--sandbox", join(out, sandbox), "--tarball", tarball, ...args],
      {
        cwd: here,
        stdio: "inherit",
        env,
      },
    ).status === 0;
  if (!ok) results.push({ name: `scaffold ${sandbox}`, ok });
  return ok;
};

let exampleOk = false;
const exampleSite = join(out, "example", "docs-site");
const exampleDist = join(exampleSite, ".docusystem", "site", "dist");
if (["axe", "csp", "drawer", "fences", "shots", "states", "switcher"].some((s) => wanted.has(s))) {
  exampleOk = scaffold("example", "--example");
}
if (exampleOk) {
  if (wanted.has("axe")) bun(["axe.ts", exampleDist], "axe");
  if (wanted.has("csp")) bun(["csp.ts", exampleDist], "csp");
  if (wanted.has("drawer")) bun(["drawer.ts", exampleDist], "drawer");
  if (wanted.has("fences")) bun(["fences.ts", exampleSite], "fences");
  if (wanted.has("shots")) bun(["shots.ts", exampleDist, join(shots, "pages")], "shots");
  if (wanted.has("states")) bun(["states.ts", exampleDist, join(shots, "states")], "states");
}
if (exampleOk && wanted.has("switcher")) {
  // a real catalog slug (hyphenated, so that the domain is the slug), from the catalog the example was built with
  const catalog = JSON.parse(
    readFileSync(join(exampleDist, "..", "data", "projects.snapshot.json"), "utf8"),
  ) as { projects: Array<{ slug: string; docs?: string | null }> };
  const slug = catalog.projects.find(
    (p) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug) && !p.docs,
  )?.slug;
  if (!slug) {
    console.error("run: the bundled catalog has no hyphenated slug without a docs site");
    results.push({ name: "switcher", ok: false });
  } else if (scaffold("switcher", "--example", "--slug", slug)) {
    bun(
      ["switcher.ts", join(out, "switcher", "docs-site", ".docusystem", "site", "dist")],
      "switcher",
    );
  }
}
if (wanted.has("edge")) {
  const f = (path: string) => join("fixtures", path);
  if (
    scaffold(
      "edge",
      ...["--branch", "main", "--name", "Sandbox", "--tagline", "An edge-case sandbox."],
      ...["--license", "MIT", "--repo", "https://github.com/Avunu/sandbox", "--slug", "sandbox"],
      ...["--doc", `README.md=${f("edge-readme.md")}`, "--doc", `chat.md=${f("chat.md")}`],
      ...["--doc", `templated.md=${f("templated.md")}`, "--repo-files", f("repo")],
      ...["--doc", `guides/README.md=${f("section/README.md")}`],
      ...["--doc", `guides/install.md=${f("section/install.md")}`],
      ...["--doc", `guides/advanced/index.md=${f("section/advanced/index.md")}`],
    )
  ) {
    bun(["edge.ts", join(out, "edge", "docs-site", "dist")], "edge");
  }
}

console.log("\n=== summary");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
const failed = results.filter((r) => !r.ok);
if (existsSync(shots)) console.log(`screenshots: ${shots}`);
if (values.out || values.keep) console.log(`sandboxes and screenshots kept in ${out}`);
else rmSync(out, { recursive: true, force: true });
console.log(
  failed.length === 0 ? "verify: all suites passed" : `verify: ${failed.length} suite(s) failed`,
);
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
