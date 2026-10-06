// The Projects menu of a docs site links each project to its docs site or, when it has none, to its
// page on avunu.net. Those pages (and https://avunu.net/projects.json, which the browser fetches
// to refresh the menu) exist only once avunu.net has relaunched, so a site enabled before then shows
// a menu of dead links. The build cannot know (it never touches the network), so what protects the
// maintainer is the order of launch, and that order has to be written where the maintainer looks: the
// list that `init` and `doctor` print, the publishing guide and the runbook. These tests hold the
// three to the facts they rest on, which are read from the bundled catalog, not repeated here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CATALOG_URL, readBundledCatalogDocument } from "../../src/lib/catalog.js";
import { maintainerSteps } from "../../src/lib/workflows.js";
import { REPO_ROOT } from "../support/index.js";

const read = (...parts: string[]): string => readFileSync(join(REPO_ROOT, ...parts), "utf8");

const maintaining = read("MAINTAINING.md");
const publishing = read("docs", "guide", "publishing.md");
const HEADING = "Launch order for the Projects menu";

/** The text of the section that starts at the heading `title`, up to the next heading of any level. */
function section(markdown: string, title: string): string {
  const start = markdown.search(new RegExp(`^#{2,4} ${title}$`, "m"));
  if (start === -1) return "";
  const rest = markdown.slice(start).split("\n").slice(1).join("\n");
  const next = rest.search(/^#{1,6} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the bundled catalog, which the launch order rests on", () => {
  const catalog = readBundledCatalogDocument();
  // What the menu links to when an entry has no docs address: its page.
  const linked = catalog.projects.filter((p) => p.docs === null);

  test("an entry without a docs address links to a page on the catalog's own site", () => {
    expect(linked.length).toBeGreaterThan(0);
    for (const p of linked) {
      expect(new URL(p.page).origin, p.slug).toBe(new URL(catalog.site).origin);
    }
  });

  test("the guide and the runbook both name the address of those pages", () => {
    // `https://avunu.net/open-source/<slug>/`: the slug segment of the path replaced by a placeholder.
    const shapes = new Set(
      linked.map((p) => {
        const url = new URL(p.page);
        const path = url.pathname.split("/").map((s) => (s === p.slug ? "<slug>" : s));
        return `${url.origin}${path.join("/")}`;
      }),
    );
    expect(shapes.size).toBeGreaterThan(0);
    for (const shape of shapes)
      expect(shape, "an entry's page ends in its slug").toContain("<slug>");
    for (const shape of shapes) {
      expect(publishing, `docs/guide/publishing.md names ${shape}`).toContain(shape);
      expect(maintaining, `MAINTAINING.md names ${shape}`).toContain(shape);
    }
  });
});

describe("the list of what a maintainer still has to do", () => {
  const steps = maintainerSteps({ domain: "frappe-nix.avunu.net", slug: "frappe-nix" });
  const enable = steps.find((s) => s.includes("DOCS_SITE_ENABLED"));

  test("enabling the site comes with the condition that avunu.net serves the catalog", () => {
    expect(enable).toBeDefined();
    expect(enable).toContain(CATALOG_URL);
    expect(enable).toContain("answer 404");
    // Still the variable, in the words the other lists use.
    expect(enable).toContain("DOCS_SITE_ENABLED = true");
    expect(enable).toContain("do not publish it");
  });
});

describe("the publishing guide and the runbook", () => {
  const runbook = section(maintaining, HEADING);

  test("the runbook has the launch order, under the gates", () => {
    expect(runbook).not.toBe("");
    expect(maintaining.indexOf(`### ${HEADING}`)).toBeGreaterThan(maintaining.indexOf("## Gates"));
    expect(maintaining.indexOf(`### ${HEADING}`)).toBeLessThan(
      maintaining.indexOf("## Verified on GitHub"),
    );
  });

  test("it puts the relaunch before enabling a site, and says what the proof pilot may do", () => {
    expect(runbook).toContain("Relaunch avunu.net first");
    expect(runbook).toContain(CATALOG_URL);
    expect(runbook).toContain("DOCS_SITE_ENABLED");
    expect(runbook).toMatch(/proof pilot may go early/i);
    expect(runbook).toContain("catalog.yml");
  });

  test("step 4 of the guide says to enable the site after the relaunch and links to the runbook", () => {
    const step = section(publishing, "What a maintainer sets, once");
    expect(step).toContain("Set it after avunu.net has relaunched");
    expect(step).toContain(CATALOG_URL);
    // The anchor GitHub makes from the heading: lower case, punctuation dropped, spaces to hyphens.
    const anchor = HEADING.toLowerCase().replaceAll(" ", "-");
    expect(step).toContain(`(../../MAINTAINING.md#${anchor})`);
  });
});
