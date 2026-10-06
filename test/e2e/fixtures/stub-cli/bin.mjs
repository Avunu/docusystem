#!/usr/bin/env node
// A stand-in for `docusystem`. Two modes, by environment:
//
//   STUB_EXPECT=<file>  a JSON file `{ pages, alerts, hrefs, srcs }` (what test-pack derives from the
//                       example's Markdown): `build` and `check` write a site that has exactly that, with
//                       `check --ci` writing the step summary and outputs. STUB_BREAK=<names> spoils the
//                       site (see builder.mjs); STUB_DIRTY=1 leaves a stray file; STUB_VERSION=<v> lies
//                       about the version; STUB_NO_OUTPUTS=1 writes no step outputs.
//   (not set)           the fleet's mode: `init --from-readme` writes docs-site/package.json (and copies
//                       the README to docs/ when there is none), `check` fails when docs/README.md says
//                       FAILCHECK.
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildDist } from "./builder.mjs";

const version = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const [command, ...args] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  console.log(process.env.STUB_VERSION ?? version);
  process.exit(0);
}

if (command === "doctor") {
  console.log("doctor: nothing to report");
  process.exit(process.env.STUB_DOCTOR_FAIL ? 1 : 0);
}

if (command === "init" && process.env.STUB_INIT_FROM) {
  // test-pack --init: write the shell of the example, as a correct init would (STUB_INIT_BREAK spoils one file)
  for (const folder of ["docs-site", ".github"]) {
    cpSync(join(process.env.STUB_INIT_FROM, folder), join(process.cwd(), folder), { recursive: true });
  }
  if (process.env.STUB_INIT_BREAK) appendFileSync(join(process.cwd(), "docs-site", ".gitignore"), "extra/\n");
  process.exit(0);
}

if (command === "init") {
  const root = process.cwd();
  if (!existsSync(join(root, "docs", "README.md"))) {
    if (args.includes("--from-readme") && existsSync(join(root, "README.md"))) {
      mkdirSync(join(root, "docs"), { recursive: true });
      copyFileSync(join(root, "README.md"), join(root, "docs", "README.md"));
    } else {
      console.error("init: docs/ has no README.md; run again with --from-readme");
      process.exit(1);
    }
  }
  if (existsSync(join(root, "docs-site", "package.json"))) {
    console.error("init: docs-site/package.json depends on @jxsuite packages: a copy of the starter; pass --force");
    process.exit(1);
  }
  mkdirSync(join(root, "docs-site"), { recursive: true });
  writeFileSync(
    join(root, "docs-site", "package.json"),
    `${JSON.stringify({ name: "stub-docs", private: true, type: "module", scripts: { check: "docusystem check" }, dependencies: { "@avunu/docusystem": "^0.0.1" } }, null, 2)}\n`,
  );
  console.log(`init: wrote docs-site (${args.join(" ")})`);
  process.exit(0);
}

if (command === "check" || command === "build") {
  const site = process.cwd();
  const expectFile = process.env.STUB_EXPECT;
  if (!expectFile) {
    const readme = join(site, "..", "docs", "README.md");
    if (readFileSync(readme, "utf8").includes("FAILCHECK")) {
      console.log("lint: error docs/README.md:3 a broken link");
      console.error("docusystem: 1 document problem(s) above fail the build.");
      process.exit(1);
    }
    console.log("check: all steps passed");
    process.exit(0);
  }
  const config = JSON.parse(readFileSync(join(site, "docusystem.config.json"), "utf8"));
  const expect = JSON.parse(readFileSync(expectFile, "utf8"));
  const dist = join(site, "dist");
  rmSync(dist, { recursive: true, force: true });
  const pages = expect.titles.map(([route, title], i) => ({
    route,
    title,
    h1: title.split(" · ")[0],
    callouts: i === 0 ? expect.alerts : 0,
  }));
  buildDist(dist, {
    site: { name: config.name, tagline: config.tagline, domain: config.domain },
    pages,
    hrefs: expect.hrefs,
    srcs: expect.srcs,
    breaks: (process.env.STUB_BREAK ?? "").split(",").filter(Boolean),
  });
  if (process.env.STUB_DIRTY) writeFileSync(join(site, "stray.txt"), "left behind\n");
  if (args.includes("--ci")) {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### Documentation site\n\nbuilt\n");
    if (process.env.GITHUB_OUTPUT && !process.env.STUB_NO_OUTPUTS) {
      appendFileSync(process.env.GITHUB_OUTPUT, `dist=${resolve(dist)}\npage-url=https://${config.domain}/\npages=${pages.length}\n`);
    }
  }
  console.log(`${command}: ${pages.length} page(s) written to ${dist}`);
  process.exit(0);
}

console.error(`stub: unknown command ${command}`);
process.exit(2);
