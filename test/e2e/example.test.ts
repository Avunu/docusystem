import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, script } from "./support.js";

// examples/basic: "a complete adopting repository". These tests read it as a person would (it is the
// reference for what `docusystem init` writes) and check it against the rules of the architecture record.
// What building it produces is checked by scripts/test-pack.mjs against the packed package.

const EXAMPLE = join(REPO_ROOT, "examples", "basic");
const SITE = join(EXAMPLE, "docs-site");
const read = (...parts: string[]) => readFileSync(join(EXAMPLE, ...parts), "utf8");
const json = (...parts: string[]) => JSON.parse(read(...parts)) as Record<string, any>;

/** Every file below `dir`, `/`-separated and relative to it, sorted. */
function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    )
    .sort();
}

describe("the shell (section 2 of the record)", () => {
  it("is exactly three files in docs-site/: nothing a shell must not contain", () => {
    expect(readdirSync(SITE).sort()).toEqual([
      ".gitignore",
      "docusystem.config.json",
      "package.json",
    ]);
  });

  it("has a package.json with one dependency, ours, and three scripts", () => {
    const manifest = json("docs-site", "package.json");
    expect(Object.keys(manifest.dependencies)).toEqual(["@avunu/docusystem"]);
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toEqual({
      dev: "docusystem dev",
      build: "docusystem build",
      check: "docusystem check",
    });
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
  });

  it("names its package after the slug: underscores become hyphens, plus -docs", () => {
    const config = json("docs-site", "docusystem.config.json");
    expect(json("docs-site", "package.json").name).toBe(`${config.slug.replaceAll("_", "-")}-docs`);
  });

  it("has the seven identity keys and the schema, and derives the domain from the slug", () => {
    const config = json("docs-site", "docusystem.config.json");
    expect(Object.keys(config).sort()).toEqual(
      ["$schema", "domain", "license", "name", "platform", "repo", "slug", "tagline"].sort(),
    );
    expect(config.$schema).toBe("./node_modules/@avunu/docusystem/config.schema.json");
    expect(config.domain).toBe(`${config.slug.replaceAll("_", "-")}.avunu.net`);
    expect(config.repo).toBe("https://github.com/Avunu/docusystem-example");
    expect(["frappe", "odoo", "wordpress", "nixos", "general"]).toContain(config.platform);
    expect(config.name.length).toBeLessThanOrEqual(80);
    expect(config.tagline.length).toBeLessThanOrEqual(200);
  });

  it("validates against config.schema.json once that exists", async () => {
    const schemaFile = join(REPO_ROOT, "config.schema.json");
    if (!existsSync(schemaFile)) return; // WP1 owns the schema; this runs after it is merged
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(JSON.parse(readFileSync(schemaFile, "utf8")));
    expect(
      validate(json("docs-site", "docusystem.config.json")),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it("ignores what the build writes, and nothing else", () => {
    expect(readFileSync(join(SITE, ".gitignore"), "utf8")).toBe(
      "node_modules/\ndist/\n.docusystem/\n",
    );
  });

  it("has no lockfile (the package is not published yet) and no bun.lock anywhere", () => {
    expect(files(EXAMPLE).filter((f) => /(^|\/)(bun\.lockb?|package-lock\.json)$/.test(f))).toEqual(
      [],
    );
  });
});

describe("the caller workflows", () => {
  const SHA = "0000000000000000000000000000000000000000";
  const docs = parse(read(".github", "workflows", "docs.yml")) as Record<string, any>;
  const publish = parse(read(".github", "workflows", "docs-publish.yml")) as Record<string, any>;
  const texts = {
    "docs.yml": read(".github", "workflows", "docs.yml"),
    "docs-publish.yml": read(".github", "workflows", "docs-publish.yml"),
  };
  const paths = [
    "docs/**",
    "docs-site/**",
    ".github/workflows/docs.yml",
    ".github/workflows/docs-publish.yml",
  ];

  it("are exactly two files, docs.yml and docs-publish.yml", () => {
    expect(files(join(EXAMPLE, ".github", "workflows"))).toEqual(["docs-publish.yml", "docs.yml"]);
  });

  it("pin every `uses:` to a 40-hex commit with the placeholder and a version comment", () => {
    for (const [file, text] of Object.entries(texts)) {
      const uses = [...text.matchAll(/^\s*uses:\s*(\S+)(.*)$/gm)];
      expect(uses.length, file).toBeGreaterThanOrEqual(1);
      for (const [, target, rest] of uses) {
        expect(target, file).toMatch(
          new RegExp(`^Avunu/docusystem/\\.github/workflows/docs-(?:build|deploy)\\.yml@${SHA}$`),
        );
        expect(rest, file).toMatch(/^\s+# v0\.0\.0$/);
      }
    }
  });

  it("docs.yml runs on pull requests only, with a read-only token and nothing else", () => {
    expect(Object.keys(docs.on)).toEqual(["pull_request"]);
    expect(docs.on.pull_request.paths).toEqual(paths);
    expect(docs.permissions).toEqual({});
    expect(Object.keys(docs.jobs)).toEqual(["build"]);
    expect(docs.jobs.build.permissions).toEqual({ contents: "read" });
    expect(docs.jobs.build.with).toEqual({ "site-directory": "docs-site" });
    expect(docs.jobs.build.uses).toContain("/docs-build.yml@");
  });

  it("docs-publish.yml runs on push and by hand, and only its deploy job may publish", () => {
    expect(Object.keys(publish.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(publish.on.push.paths).toEqual(paths);
    expect(publish.permissions).toEqual({});
    expect(publish.jobs.build.permissions).toEqual({ contents: "read" });
    expect(publish.jobs.build.with).toEqual({
      "site-directory": "docs-site",
      "pages-artifact": "${{ vars.DOCS_SITE_ENABLED == 'true' }}",
    });
    expect(publish.jobs.deploy.needs).toBe("build");
    expect(publish.jobs.deploy.if).toBe("${{ vars.DOCS_SITE_ENABLED == 'true' }}");
    expect(publish.jobs.deploy.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(publish.jobs.deploy.uses).toContain("/docs-deploy.yml@");
  });

  it("never trigger on pull_request_target or workflow_run, and name no branch", () => {
    for (const [file, text] of Object.entries(texts)) {
      expect(text, file).not.toMatch(/pull_request_target|workflow_run/);
      expect(text, file).not.toMatch(/^\s*branches:/m);
    }
  });

  it("watch the docs folder and the site folder the config names", () => {
    expect(paths.slice(0, 2)).toEqual(["docs/**", `${"docs-site"}/**`]);
    expect(json("docs-site", "docusystem.config.json").docs).toBeUndefined(); // the default, ../docs
  });

  it("equal the scaffold rendered with the example's values, once the scaffold exists", () => {
    const scaffold = join(REPO_ROOT, "scaffold");
    if (!existsSync(join(scaffold, "docs.yml"))) return; // WP6 owns the scaffold; this runs after it is merged
    for (const file of ["docs.yml", "docs-publish.yml"]) {
      const rendered = readFileSync(join(scaffold, file), "utf8")
        .replaceAll("@@DOCS@@", "docs")
        .replaceAll("@@SITE@@", "docs-site")
        .replaceAll("@@SHA@@", SHA)
        .replaceAll("@@VERSION@@", "v0.0.0");
      expect(texts[file as keyof typeof texts], file).toBe(rendered);
    }
  });
});

describe("dependabot.yml", () => {
  const dependabot = parse(read(".github", "dependabot.yml")) as {
    version: number;
    updates: Array<Record<string, any>>;
  };

  it("keeps the package and the workflow pin current, one entry per ecosystem and directory", () => {
    expect(dependabot.version).toBe(2);
    const keys = dependabot.updates.map((u) => `${u["package-ecosystem"]} ${u.directory}`);
    expect(keys).toEqual(["npm /docs-site", "github-actions /"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not delay our own package or workflow", () => {
    const [npm, actions] = dependabot.updates;
    expect(npm!.cooldown.exclude).toEqual(["@avunu/docusystem"]);
    expect(actions!.cooldown.exclude).toEqual(["Avunu/docusystem"]);
    expect(npm!["commit-message"].prefix).toBe("chore");
  });
});

describe("the documentation", () => {
  const DOCS = join(EXAMPLE, "docs");
  const pages = files(DOCS).filter((f) => f.endsWith(".md"));
  const text = (page: string) => readFileSync(join(DOCS, page), "utf8");
  const all = pages.map(text).join("\n");

  it("has a home page, a folder page for each section and pages in them", () => {
    expect(pages).toEqual([
      "README.md",
      "guide/README.md",
      "guide/configuration.md",
      "guide/install.md",
      "guide/troubleshooting.md",
      "guide/writing.md",
      "reference/README.md",
      "reference/commands.md",
    ]);
  });

  it("gives every page front matter with a title and a body heading that says the same", () => {
    for (const page of pages) {
      const body = text(page).replace(/^<!--[\s\S]*?-->\n/, "");
      const front = /^---\n([\s\S]*?)\n---\n/.exec(body)?.[1] ?? "";
      const title = /^title:\s*(.+)$/m.exec(front)?.[1];
      expect(title, page).toBeTruthy();
      expect(body, page).toMatch(
        new RegExp(`^# ${title!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
      );
      expect(body.match(/^# /gm), page).toHaveLength(1);
      expect(front, page).toMatch(/^order: \d+$/m);
    }
  });

  it("has a copyright comment above the front matter of exactly one page", () => {
    const stamped = pages.filter((p) =>
      /^<!-- Copyright \(c\) 2026 Avunu LLC -->\n---\n/.test(text(p)),
    );
    expect(stamped).toEqual(["guide/troubleshooting.md"]);
  });

  it("uses every kind of GitHub alert", () => {
    for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      expect(all, kind).toMatch(new RegExp(`^> \\[!${kind}\\]$`, "m"));
    }
  });

  it("has links between pages, to a file of the repository, to a folder, and an image of each kind", () => {
    expect(all).toMatch(/\]\(install\.md#check-it\)/);
    expect(all).toMatch(/\]\(\.\.\/\.\.\/src\/worker\.ts#L5\)/);
    expect(all).toMatch(/\]\(\.\.\/\.\.\/src\)/);
    expect(all).toMatch(/!\[[^\]]+\]\(\.\.\/images\/shell\.png\)/);
    expect(all).toMatch(/!\[[^\]]+\]\(\.\.\/\.\.\/assets\/logo\.svg\)/);
  });

  it("uses no Markdown the site would lose: reference links, footnotes, task lists, raw anchors, details", () => {
    expect(all).not.toMatch(/^\[[^\]]+\]: /m);
    expect(all).not.toMatch(/\[\^[^\]]+\]/);
    expect(all).not.toMatch(/^\s*[-*] \[[ x]\] /m);
    expect(all).not.toMatch(/<a\s+href|<details/);
  });

  it("links only to files that exist", () => {
    for (const page of pages) {
      for (const m of text(page).matchAll(/!?\[[^\]]*\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
        const target = m[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        expect(existsSync(join(DOCS, page, "..", target)), `${page}: ${target}`).toBe(true);
      }
    }
  });

  it("has images that are what they say they are", () => {
    const png = readFileSync(join(DOCS, "images", "shell.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(statSync(join(DOCS, "images", "shell.png")).size).toBeLessThan(50_000);
    expect(read("assets", "logo.svg")).toMatch(/^<svg /);
  });

  it("makes no claim about price, clients or numbers", () => {
    expect(all).not.toMatch(/\$\d|per month|pricing|customers?/i);
  });
});

describe("the rest of the repository", () => {
  it("is a project of its own: a README, an MIT license in the name of Avunu LLC, and a source file", () => {
    expect(read("README.md")).toMatch(/^# Docusystem example/);
    expect(read("LICENSE")).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Avunu LLC\n/);
    expect(existsSync(join(EXAMPLE, "src", "worker.ts"))).toBe(true);
  });

  it("keeps its formatter out of the Markdown, which staging repairs and a formatter would break", () => {
    const config = json(".oxfmtrc.json");
    expect(config.ignorePatterns).toContain("docs");
    expect(config.printWidth).toBe(120); // the callers' `paths:` list stays on one line, as init writes it
  });
});

describe("what test-pack expects of the build, derived from the Markdown", () => {
  interface Derive {
    deriveExpectations: (o: { root: string; repo: string; name: string }) => {
      pages: number;
      alerts: number;
      titles: Array<[string, string]>;
      hrefs: string[];
      srcs: string[];
    };
  }
  let derived: ReturnType<Derive["deriveExpectations"]>;
  const repo = "https://github.com/Avunu/docusystem-example";

  beforeAll(async () => {
    const { deriveExpectations } = await script<Derive>("test-pack.mjs");
    derived = deriveExpectations({ root: EXAMPLE, repo, name: "Docusystem Example" });
  });

  it("counts the pages and the alerts", () => {
    expect(derived.pages).toBe(8);
    expect(derived.alerts).toBe(12);
  });

  it("titles every page, the home page not being named after the project", () => {
    expect(derived.titles).toContainEqual([
      "/docs/",
      "Docusystem example documentation · Docusystem Example",
    ]);
    expect(derived.titles).toContainEqual(["/docs/guide/", "Guide · Docusystem Example"]);
    expect(derived.titles).toContainEqual([
      "/docs/guide/writing/",
      "Writing pages · Docusystem Example",
    ]);
    expect(derived.titles).toHaveLength(8);
  });

  it("expects the pages, the repository's files and folders on GitHub, and its image as a raw file", () => {
    expect(derived.hrefs).toEqual(
      expect.arrayContaining([
        "/docs/guide/install/#check-it",
        "/docs/reference/commands/",
        `${repo}/blob/main/src/worker.ts`,
        `${repo}/blob/main/src/worker.ts#L5`,
        `${repo}/blob/main/LICENSE`,
        `${repo}/blob/main/docs-site/docusystem.config.json`,
        `${repo}/tree/main/src`,
        `${repo}/tree/main/docs-site`,
        `${repo}/edit/main/docs/guide/writing.md`,
        `${repo}/edit/main/docs/README.md`,
      ]),
    );
    expect(derived.srcs).toEqual([`${repo}/raw/main/assets/logo.svg`]);
  });
});
