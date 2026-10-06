// The checks that need the package's REAL `site/` folder (WP7). Until WP7 merges there is no such
// folder in the repository and this file is skipped; after the merge it runs without a change and is
// part of the integration of WP2 and WP7:
//
// - `generateProject` for the pilots' values equals the starter's `project.json` (a copy of
//   Avunu/docs `Sites/project-docs-starter/template/project.json` at 1820d01 is in
//   fixtures/starter-project.json) except `$schema`, `name`, `url`, `links` and the one line WP7
//   changes, `content.config.source` (`./docs.config.json` becomes `./docusystem.config.json`);
// - an assembled root of the real `site/`, built by the real pinned Jx, yields `Done: N routes`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { assemble } from "../../src/lib/assemble.js";
import { jxCli } from "../../src/lib/jx.js";
import { ejectableFiles, ejectFile, overrideFindings } from "../../src/lib/overrides.js";
import { generateProject, knownTokens, readBaseProject } from "../../src/lib/project.js";
import type { DocsConfig } from "../../src/lib/types.js";
import { tempDir, writeTree } from "../support/index.js";
import { REAL_SITE, argsFor, makeShell } from "./helpers.js";

vi.setConfig({ testTimeout: 60_000 });

const hasSite = existsSync(join(REAL_SITE, "project.base.json"));

/** The three pilots' values (the public names of Avunu's own repositories). */
const PILOTS: DocsConfig[] = [
  {
    name: "frappe-nix",
    tagline:
      "Reproducible Nix infrastructure for Frappe and ERPNext, from the development shell to OCI containers and a multi-site NixOS module.",
    slug: "frappe-nix",
    platform: "nixos",
    repo: "https://github.com/Avunu/frappe-nix",
    domain: "frappe-nix.avunu.net",
    license: "MIT",
  },
  {
    name: "ERPNext TaskView",
    tagline: "Task views for ERPNext.",
    slug: "erpnext_taskview",
    platform: "frappe",
    repo: "https://github.com/Avunu/erpnext_taskview",
    domain: "erpnext-taskview.avunu.net",
    license: "MIT",
  },
  {
    name: "Cloudflare Email",
    tagline: "Email delivery through Cloudflare.",
    slug: "cloudflare-email-relay",
    platform: "general",
    repo: "https://github.com/Avunu/cloudflare-email-relay",
    domain: "cloudflare-email.avunu.net",
    license: "MIT",
  },
];

describe.skipIf(!hasSite)("against the package's real site/ (needs WP7)", () => {
  const starter = JSON.parse(
    readFileSync(fileURLToPath(new URL("fixtures/starter-project.json", import.meta.url)), "utf8"),
  ) as Record<string, any>;

  test.each(PILOTS)(
    "generateProject for $slug equals the starter's project.json except $schema, name, url, links and the config source",
    (pilot) => {
      for (const strict of [false, true]) {
        const { project, errors, warnings } = generateProject(pilot, { strict });
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);

        const expected = structuredClone(starter);
        delete expected.$schema;
        expected.name = pilot.name;
        expected.url = `https://${pilot.domain}`;
        expected.content.docs.links = strict ? "error" : "warn";
        expected.content.config.source = "./docusystem.config.json";
        expect(project).toEqual(expected);
      }
    },
  );

  test("the base project's tokens are the ones the starter's are, and theme overrides pass for them", () => {
    const base = readBaseProject();
    const known = knownTokens(base);
    expect(known.light.has("--color-action")).toBe(true);
    expect(known.dark.has("--color-action")).toBe(true);
    const { errors } = generateProject(PILOTS[0] as DocsConfig, { strict: true });
    expect(errors).toEqual([]);
    const themed = generateProject(
      { ...(PILOTS[0] as DocsConfig), theme: { light: { "--color-action": "#4B2A99" } } },
      { strict: true },
    );
    expect(themed.errors).toEqual([]);
    expect((themed.project.style as Record<string, unknown>)["--color-action"]).toBe("#4B2A99");
  });

  test("every Jx file of the package can be ejected and then reports as current", () => {
    const site = tempDir();
    const files = ejectableFiles();
    expect(files.length).toBeGreaterThanOrEqual(17); // 12 components, 2 layouts, 3 pages
    for (const rel of files) ejectFile(site, rel);
    expect(overrideFindings(site).map((f) => f.level)).toEqual(files.map(() => "ok"));
  });

  test("assembled, an unmodified root of the real site builds with the real pinned Jx", async () => {
    const shell = makeShell();
    const result = await assemble(argsFor(shell, { strict: true }));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.shadowed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.manifest.files["components/docs-header.json"]).toBe("package");
    expect(result.manifest.files["public/.nojekyll"]).toBe("package");
    expect(Object.keys(result.manifest.files).some((f) => f.startsWith("public/fonts/"))).toBe(
      true,
    );
    expect(existsSync(join(shell.paths.root, "public", "CNAME"))).toBe(true);

    // What steps 5 and 7 of the pipeline would stage: the home page of docs/ and the sidebar data.
    writeTree(shell.paths.stagedDocs, { "README.md": "---\ntitle: Home\n---\n\nHello.\n" });
    writeFileSync(
      shell.paths.navFile,
      JSON.stringify({
        home: { label: "Example", url: "/docs/" },
        loose: [],
        sections: [],
        expandAll: true,
        pages: {
          "/docs/": {
            title: "Home",
            description: "",
            section: "",
            prev: null,
            next: null,
            edit: "README.md",
          },
        },
        flat: [{ title: "Home", url: "/docs/" }],
        featured: [],
      }),
    );
    const run = spawnSync(process.execPath, [jxCli(), "build", shell.paths.root], {
      cwd: shell.paths.root,
      encoding: "utf8",
    });
    const output = `${run.stdout}${run.stderr}`;
    expect(run.status).toBe(0);
    expect(output).toMatch(/^Done: 3 routes/m); // /, /404/ and the documentation home
    expect(output.split("\n").filter((l) => /^(?:Content\b|Warning:|Error)/.test(l))).toEqual([]);
  });
});
