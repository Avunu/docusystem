import { describe, expect, test } from "vitest";
import {
  DependabotShapeError,
  actionsSnippet,
  cooldownAdvice,
  dependabotFile,
  ensureDependabotEntries,
  npmSnippet,
  readDependabotEntries,
} from "../../src/lib/dependabot.js";
import { readFixture } from "./support/fixtures.js";
import { makeRepo, PILOTS } from "./support/shell.js";

const ADD = { site: "docs-site", actions: true };

/** The ecosystem and directories of every entry. */
const summary = (text: string): string[] =>
  readDependabotEntries(text).entries.map((e) => `${e.ecosystem} ${e.directories.join(",")}`);

/** A pilot's file as it was before the site's entry was added: everything above the entry's comment. */
function withoutSiteEntry(pilot: string): string {
  const text = readFixture("pilots", pilot, ".github", "dependabot.yml");
  const lines = text.split("\n");
  const at = lines.findLastIndex((line) => line.startsWith("  # The documentation site"));
  expect(at, pilot).toBeGreaterThan(0);
  return lines.slice(0, at).join("\n").trimEnd() + "\n";
}

describe("a file that does not exist", () => {
  test("is created with both entries", () => {
    const { text, changes } = ensureDependabotEntries(null, ADD);
    expect(text.startsWith("version: 2\nupdates:\n  # The documentation site (docs-site/)")).toBe(
      true,
    );
    expect(summary(text)).toEqual(["npm /docs-site", "github-actions /"]);
    expect(changes).toEqual([
      "added the npm entry for /docs-site",
      "added the github-actions entry for /",
    ]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain(npmSnippet("docs-site").trimEnd());
    expect(text).toContain(actionsSnippet().trimEnd());
  });

  test("without actions it has the npm entry only", () => {
    const { text, changes } = ensureDependabotEntries(null, { site: "docs-site", actions: false });
    expect(summary(text)).toEqual(["npm /docs-site"]);
    expect(changes).toEqual(["added the npm entry for /docs-site"]);
  });

  test("an empty file is the same as none, and a file of comments keeps them", () => {
    expect(ensureDependabotEntries("", ADD).text).toBe(ensureDependabotEntries(null, ADD).text);
    const { text } = ensureDependabotEntries("# managed by hand\n", ADD);
    expect(text.startsWith("# managed by hand\n")).toBe(true);
    expect(summary(text)).toEqual(["npm /docs-site", "github-actions /"]);
  });

  test("a nested site folder is the directory", () => {
    const { text } = ensureDependabotEntries(null, { site: "tools/docs-site", actions: false });
    expect(summary(text)).toEqual(["npm /tools/docs-site"]);
  });
});

describe.each(PILOTS)("the real dependabot.yml of %s", (pilot) => {
  const real = readFixture("pilots", pilot, ".github", "dependabot.yml");

  test("has a bun entry for the site: it becomes npm in place, keeps its cooldown but excludes the package, and nothing else is added", () => {
    const { text, changes } = ensureDependabotEntries(real, ADD);
    expect(changes.slice(0, 2)).toEqual([
      "converted the bun entry for /docs-site to npm",
      "excluded @avunu/docusystem from the cooldown of the npm entry for /docs-site",
    ]);
    const before = real.split("\n");
    const after = text.split("\n");
    // two lines more (the exclude list); everything else is the same line, or the one that said bun
    expect(after).toHaveLength(before.length + 2);
    const at = after.indexOf("      exclude:");
    expect(after.slice(at, at + 2)).toEqual(["      exclude:", '        - "@avunu/docusystem"']);
    const rest = [...after.slice(0, at), ...after.slice(at + 2)];
    const differing = rest.flatMap((line, i) => (line === before[i] ? [] : [[before[i], line]]));
    for (const [was, now] of differing) {
      expect(
        was === "  - package-ecosystem: bun"
          ? now === "  - package-ecosystem: npm"
          : was?.replace("Bun", "npm") === now,
        `${was} -> ${now}`,
      ).toBe(true);
    }
    expect(summary(text)).toContain("npm /docs-site");
    expect(summary(text)).not.toContain("bun /docs-site");
    const converted = readDependabotEntries(text).entries.find(
      (e) => e.ecosystem === "npm" && e.directories.includes("/docs-site"),
    );
    expect(converted?.cooldown).toEqual({ present: true, excludes: ["@avunu/docusystem"] });
    // nothing in the converted file still says that the site is a Bun site
    expect(text.replaceAll("bun.lock", "")).not.toMatch(/\bBun\b/);
  });

  test("before the site was added (updates: is the last key): the entry is appended after the text, untouched", () => {
    const earlier = withoutSiteEntry(pilot);
    const { text, changes } = ensureDependabotEntries(earlier, ADD);
    expect(text.startsWith(earlier)).toBe(true);
    // the github-actions entry is added only to a file that has none (the cut file of one pilot has none)
    const hasActions = summary(earlier).includes("github-actions /");
    expect(changes).toEqual([
      "added the npm entry for /docs-site",
      ...(hasActions ? [] : ["added the github-actions entry for /"]),
    ]);
    expect(summary(text)).toEqual([
      ...summary(earlier),
      "npm /docs-site",
      ...(hasActions ? [] : ["github-actions /"]),
    ]);
    expect(readDependabotEntries(text).error).toBeUndefined();
  });

  test("running it again changes nothing", () => {
    const once = ensureDependabotEntries(withoutSiteEntry(pilot), ADD).text;
    const twice = ensureDependabotEntries(once, ADD);
    expect(twice.changes).toEqual([]);
    expect(twice.text).toBe(once);
    expect(ensureDependabotEntries(real, ADD).text).toBe(
      ensureDependabotEntries(ensureDependabotEntries(real, ADD).text, ADD).text,
    );
  });
});

describe("where the entries are inserted", () => {
  const entry = (ecosystem: string, directory: string): string =>
    `  - package-ecosystem: ${ecosystem}\n    directory: ${directory}\n    schedule:\n      interval: daily # when\n`;

  test("updates: is not the last key: the entries go after the last one and every other line stays", () => {
    const original = [
      "# my file",
      "version: 2",
      "",
      "updates:",
      entry("npm", "/").trimEnd(),
      "# the registries below are private",
      "registries:",
      "  github:",
      "    type: npm-registry",
      "    url: https://npm.pkg.github.com",
      "",
    ].join("\n");
    const { text, changes } = ensureDependabotEntries(original, ADD);
    expect(changes).toHaveLength(2);
    expect(summary(text)).toEqual(["npm /", "npm /docs-site", "github-actions /"]);
    // every original line is still there, in order
    const lines = text.split("\n");
    let at = 0;
    for (const line of original.split("\n")) {
      const found = lines.indexOf(line, at);
      expect(found, line).toBeGreaterThanOrEqual(at);
      at = found + 1;
    }
    // the comment that belongs to the next key is still right above it
    expect(text).toContain("# the registries below are private\nregistries:\n");
    expect(readDependabotEntries(text).error).toBeUndefined();
    expect(text.indexOf("docs-site")).toBeLessThan(text.indexOf("registries:"));
  });

  test("a list indented to the margin gets entries at the margin", () => {
    const original =
      "version: 2\nupdates:\n- package-ecosystem: npm\n  directory: /\n  schedule:\n    interval: daily\n";
    const { text } = ensureDependabotEntries(original, ADD);
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("\n- package-ecosystem: npm\n  directory: /docs-site\n");
    expect(summary(text)).toEqual(["npm /", "npm /docs-site", "github-actions /"]);
  });

  test("a list at the margin followed by another key gets its entries before that key", () => {
    const original =
      "version: 2\nupdates:\n- package-ecosystem: pip\n  directory: /\nregistries:\n  a:\n    type: npm-registry\n";
    const { text } = ensureDependabotEntries(original, ADD);
    expect(summary(text)).toEqual(["pip /", "npm /docs-site", "github-actions /"]);
    expect(text.endsWith("registries:\n  a:\n    type: npm-registry\n")).toBe(true);
    expect(text.indexOf("github-actions")).toBeLessThan(text.indexOf("registries:"));
    expect(readDependabotEntries(text).error).toBeUndefined();
  });

  test("a list indented by four gets entries by four", () => {
    const original =
      "version: 2\nupdates:\n    - package-ecosystem: pip\n      directory: /\n      schedule:\n        interval: daily\n";
    const { text } = ensureDependabotEntries(original, ADD);
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("\n    - package-ecosystem: npm\n      directory: /docs-site\n");
    expect(summary(text)).toEqual(["pip /", "npm /docs-site", "github-actions /"]);
  });

  test("a file without a final newline gets one before the entries", () => {
    const { text } = ensureDependabotEntries(
      "version: 2\nupdates:\n  - package-ecosystem: pip\n    directory: /",
      ADD,
    );
    expect(summary(text)).toEqual(["pip /", "npm /docs-site", "github-actions /"]);
    expect(text).toContain("directory: /\n\n  # The documentation site");
  });

  test("updates: [] is replaced by a list with the entries, the rest of the file kept", () => {
    const { text } = ensureDependabotEntries("# c\nversion: 2\nupdates: []\n", ADD);
    expect(text.startsWith("# c\nversion: 2\n")).toBe(true);
    expect(summary(text)).toEqual(["npm /docs-site", "github-actions /"]);
    expect(text).toContain("  - package-ecosystem: npm");
    expect(text).not.toContain("[]");
    expect(text).toContain("# The documentation site (docs-site/)");
  });

  test("updates: with nothing after it is a list too", () => {
    const { text } = ensureDependabotEntries("version: 2\nupdates:\n", ADD);
    expect(summary(text)).toEqual(["npm /docs-site", "github-actions /"]);
  });

  test("a flow list gets the entries added to it", () => {
    const { text } = ensureDependabotEntries(
      "version: 2\nupdates: [{package-ecosystem: pip, directory: /, schedule: {interval: weekly}}]\n",
      ADD,
    );
    expect(summary(text)).toEqual(["pip /", "npm /docs-site", "github-actions /"]);
    expect(readDependabotEntries(text).error).toBeUndefined();
  });

  test("no updates: key: it is appended", () => {
    const { text } = ensureDependabotEntries("version: 2\n", ADD);
    expect(text.startsWith("version: 2\n")).toBe(true);
    expect(summary(text)).toEqual(["npm /docs-site", "github-actions /"]);
  });

  test("CRLF files get CRLF entries", () => {
    const original = "version: 2\r\nupdates:\r\n  - package-ecosystem: pip\r\n    directory: /\r\n";
    const { text } = ensureDependabotEntries(original, ADD);
    expect(text.startsWith(original)).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(summary(text)).toEqual(["pip /", "npm /docs-site", "github-actions /"]);
  });
});

describe("what counts as an entry for the site (the judges' false OKs)", () => {
  test("`npm /` followed by `bun /docs-site` is not an npm entry for the site", () => {
    const original = [
      "version: 2",
      "updates:",
      "  - package-ecosystem: npm",
      "    directory: /",
      "  - package-ecosystem: github-actions",
      "    directory: /",
      "  - package-ecosystem: bun",
      "    directory: /docs-site",
      "",
    ].join("\n");
    const { text, changes } = ensureDependabotEntries(original, ADD);
    expect(changes).toEqual(["converted the bun entry for /docs-site to npm"]);
    expect(summary(text)).toEqual(["npm /", "github-actions /", "npm /docs-site"]);
  });

  test("an npm entry for the root is not an entry for the site", () => {
    const { text, changes } = ensureDependabotEntries(
      "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n",
      { site: "docs-site", actions: false },
    );
    expect(changes).toEqual(["added the npm entry for /docs-site"]);
    expect(summary(text)).toEqual(["npm /", "npm /docs-site"]);
  });

  test("a site folder that is a prefix of another is a different directory", () => {
    const { changes } = ensureDependabotEntries(
      "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /docs-site-old\n",
      { site: "docs-site", actions: false },
    );
    expect(changes).toEqual(["added the npm entry for /docs-site"]);
  });

  test("directories: lists, trailing slashes and quoted values are read", () => {
    const original = [
      "version: 2",
      "updates:",
      "  - package-ecosystem: 'npm'",
      "    directories: ['/', \"/docs-site/\"]",
      "  - package-ecosystem: github-actions",
      '    directory: "/"',
      "",
    ].join("\n");
    expect(ensureDependabotEntries(original, ADD)).toEqual({ text: original, changes: [] });
  });

  test("a bun entry for several directories is left alone and an npm entry is added", () => {
    const original =
      "version: 2\nupdates:\n  - package-ecosystem: bun\n    directories: ['/docs-site', '/other']\n";
    const { text, changes } = ensureDependabotEntries(original, {
      site: "docs-site",
      actions: false,
    });
    expect(changes).toEqual(["added the npm entry for /docs-site"]);
    expect(text.startsWith(original)).toBe(true);
    expect(summary(text)).toEqual(["bun /docs-site,/other", "npm /docs-site"]);
  });

  test("a github-actions entry for another directory is not the one for /", () => {
    const original =
      "version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /sub\n";
    expect(ensureDependabotEntries(original, ADD).changes).toEqual([
      "added the npm entry for /docs-site",
      "added the github-actions entry for /",
    ]);
  });

  test("a bun entry that was quoted keeps its quotes when converted", () => {
    const original =
      'version: 2\nupdates:\n  - package-ecosystem: "bun"\n    directory: "/docs-site"\n';
    const { text } = ensureDependabotEntries(original, { site: "docs-site", actions: false });
    expect(text).toBe(
      'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/docs-site"\n',
    );
  });
});

describe("a bun entry with a cooldown: the package is excluded from it", () => {
  const NPM = { site: "docs-site", actions: false };
  const EXCLUDE = '"@avunu/docusystem"';
  const excludes = (text: string): string[] =>
    readDependabotEntries(text).entries.find((e) => e.directories.includes("/docs-site"))?.cooldown
      .excludes ?? [];
  const bunEntry = (cooldown: string[], rest: string[] = []): string =>
    [
      "version: 2",
      "updates:",
      "  - package-ecosystem: bun",
      "    directory: /docs-site",
      "    schedule:",
      "      interval: weekly",
      ...cooldown,
      ...rest,
      "",
    ].join("\n");

  test("a block cooldown gets an exclude list after its last line, before the next key and its comments", () => {
    const original = bunEntry(
      ["    cooldown:", "      default-days: 7 # a week"],
      [
        "",
        "    # why grouped",
        "    groups:",
        "      docs-site-packages:",
        '        patterns: ["*"]',
      ],
    );
    const { text, changes } = ensureDependabotEntries(original, NPM);
    expect(text).toBe(
      original
        .replace("package-ecosystem: bun", "package-ecosystem: npm")
        .replace(
          "default-days: 7 # a week\n",
          `default-days: 7 # a week\n      exclude:\n        - ${EXCLUDE}\n`,
        ),
    );
    expect(changes).toEqual([
      "converted the bun entry for /docs-site to npm",
      "excluded @avunu/docusystem from the cooldown of the npm entry for /docs-site",
    ]);
    expect(excludes(text)).toEqual(["@avunu/docusystem"]);
    expect(cooldownAdvice(text, NPM)).toEqual([]);
  });

  test("an exclude list of other packages gets the package as one more item, in the list's own indentation", () => {
    const original = bunEntry(
      [
        "    cooldown:",
        "      default-days: 7",
        "      exclude:",
        "      - left-pad # old",
        "      - other",
      ],
      ["    commit-message:", "      prefix: chore"],
    );
    const { text } = ensureDependabotEntries(original, NPM);
    expect(text).toContain(`      - other\n      - ${EXCLUDE}\n    commit-message:`);
    expect(excludes(text)).toEqual(["left-pad", "other", "@avunu/docusystem"]);
  });

  test("a cooldown that excludes the package already is left as it is", () => {
    const original = bunEntry([
      "    cooldown:",
      "      default-days: 7",
      "      exclude:",
      `        - ${EXCLUDE}`,
    ]);
    const { text, changes } = ensureDependabotEntries(original, NPM);
    expect(text).toBe(original.replace("package-ecosystem: bun", "package-ecosystem: npm"));
    expect(changes).toEqual(["converted the bun entry for /docs-site to npm"]);
  });

  test("an entry without a cooldown gets none", () => {
    const original = bunEntry([]);
    const { text, changes } = ensureDependabotEntries(original, NPM);
    expect(text).toBe(original.replace("package-ecosystem: bun", "package-ecosystem: npm"));
    expect(changes).toEqual(["converted the bun entry for /docs-site to npm"]);
  });

  test("the cooldown may come before the ecosystem, and the entry may be followed by others", () => {
    const original = [
      "version: 2",
      "updates:",
      "  - cooldown:",
      "      default-days: 3",
      "    package-ecosystem: bun",
      "    directory: /docs-site",
      "  - package-ecosystem: pip",
      "    directory: /",
      "",
    ].join("\n");
    const { text } = ensureDependabotEntries(original, NPM);
    expect(text).toBe(
      [
        "version: 2",
        "updates:",
        "  - cooldown:",
        "      default-days: 3",
        "      exclude:",
        `        - ${EXCLUDE}`,
        "    package-ecosystem: npm",
        "    directory: /docs-site",
        "  - package-ecosystem: pip",
        "    directory: /",
        "",
      ].join("\n"),
    );
  });

  test("with an entry to add after it (the github-actions one), both edits land where they belong", () => {
    const original = bunEntry(["    cooldown:", "      default-days: 7"]);
    const { text, changes } = ensureDependabotEntries(original, ADD);
    expect(summary(text)).toEqual(["npm /docs-site", "github-actions /"]);
    expect(excludes(text)).toEqual(["@avunu/docusystem"]);
    expect(text).toContain(
      `        - ${EXCLUDE}\n\n  # The pinned commit of the shared documentation workflows`,
    );
    expect(changes).toContain("added the github-actions entry for /");
    expect(readDependabotEntries(text).error).toBeUndefined();
  });

  test("a file without a final newline and CRLF line ends keep their style", () => {
    const original = bunEntry(["    cooldown:", "      default-days: 7"]).trimEnd();
    const bare = ensureDependabotEntries(original, NPM).text;
    expect(excludes(bare)).toEqual(["@avunu/docusystem"]);
    expect(bare.startsWith(original.replace("bun", "npm"))).toBe(true);
    const crlf = ensureDependabotEntries(original.replace(/\n/g, "\r\n"), NPM).text;
    expect(crlf.replace(/\r\n/g, "")).not.toContain("\n");
    expect(crlf).toContain(`      exclude:\r\n        - ${EXCLUDE}`);
    expect(excludes(crlf)).toEqual(["@avunu/docusystem"]);
  });

  test("a flow list of entries (the Document API path) gets it too", () => {
    const original =
      "version: 2\nupdates: [{package-ecosystem: bun, directory: /docs-site, cooldown: {default-days: 7}}]\n";
    const { text, changes } = ensureDependabotEntries(original, NPM);
    expect(summary(text)).toEqual(["npm /docs-site"]);
    expect(excludes(text)).toEqual(["@avunu/docusystem"]);
    expect(changes).toContain(
      "excluded @avunu/docusystem from the cooldown of the npm entry for /docs-site",
    );
  });

  test.each([
    ["a flow cooldown", "    cooldown: {default-days: 7}"],
    ["a flow exclude list", "    cooldown:\n      default-days: 7\n      exclude: [left-pad]"],
    ["an empty exclude", "    cooldown:\n      default-days: 7\n      exclude:"],
  ])(
    "%s cannot be extended in place: it is converted, the cooldown is untouched and the advice says what to add",
    (_name, cooldown) => {
      const original = bunEntry([cooldown]);
      const { text, changes } = ensureDependabotEntries(original, NPM);
      expect(text).toBe(original.replace("package-ecosystem: bun", "package-ecosystem: npm"));
      expect(changes).toEqual(["converted the bun entry for /docs-site to npm"]);
      const [advice] = cooldownAdvice(text, NPM);
      expect(advice).toContain(
        'the npm entry for /docs-site has a cooldown that does not exclude "@avunu/docusystem"',
      );
      expect(advice).toContain(`exclude:\n  - ${EXCLUDE}`);
    },
  );

  test("running it again changes nothing", () => {
    const once = ensureDependabotEntries(
      bunEntry(["    cooldown:", "      default-days: 7"]),
      ADD,
    ).text;
    expect(ensureDependabotEntries(once, ADD)).toEqual({ text: once, changes: [] });
  });
});

describe("the comments of a converted entry", () => {
  const NPM = { site: "docs-site", actions: false };
  const convert = (lines: string[]): string =>
    ensureDependabotEntries(
      [
        "version: 2",
        "updates:",
        ...lines,
        "  - package-ecosystem: bun",
        "    directory: /docs-site",
        "",
      ].join("\n"),
      NPM,
    ).text;

  test("a comment block about the site that names Bun says npm now, here or on the entry before", () => {
    const text = convert([
      "  # The documentation site (docs-site/): the pinned actions and the site's own Bun",
      "  # packages; Bun is its package manager.",
      "  - package-ecosystem: github-actions",
      "    directory: /",
    ]);
    expect(text).toContain("the site's own npm\n  # packages; npm is its package manager.");
  });

  test("a comment that is not about the site, and every other mention of bun, stays", () => {
    const text = convert([
      "  # The mobile app is built with Bun; its entry is below.",
      "  - package-ecosystem: github-actions",
      "    directory: /",
      "",
      "  # docs-site/ had a bun.lock once, which Bun wrote.",
    ]);
    expect(text).toContain("# The mobile app is built with Bun;");
    expect(text).toContain("had a bun.lock once, which npm wrote.");
  });

  test("an entry that is not converted keeps its comments", () => {
    const original =
      "version: 2\nupdates:\n  # docs-site/ uses Bun for something else\n  - package-ecosystem: bun\n    directories: ['/docs-site', '/other']\n";
    expect(ensureDependabotEntries(original, NPM).text.startsWith(original)).toBe(true);
  });
});

describe("cooldownAdvice", () => {
  const file = (entries: string[]): string => `version: 2\nupdates:\n${entries.join("")}`;
  const npmEntry = (cooldown: string): string =>
    `  - package-ecosystem: npm\n    directory: /docs-site\n${cooldown}`;
  const actionsEntry = (cooldown: string): string =>
    `  - package-ecosystem: github-actions\n    directory: /\n${cooldown}`;
  const COOLDOWN = "    cooldown:\n      default-days: 7\n";
  const EXCLUDING = (name: string): string => `${COOLDOWN}      exclude:\n        - "${name}"\n`;

  test("an npm entry for the site whose cooldown holds the package back", () => {
    const [advice, ...more] = cooldownAdvice(file([npmEntry(COOLDOWN)]), ADD);
    expect(more).toEqual([]);
    expect(advice).toBe(
      'the npm entry for /docs-site has a cooldown that does not exclude "@avunu/docusystem", so a release of the package would wait for it; add this under its cooldown:\nexclude:\n  - "@avunu/docusystem"',
    );
  });

  test("a github-actions entry whose cooldown holds the shared workflows back", () => {
    const [advice, ...more] = cooldownAdvice(file([actionsEntry(COOLDOWN)]), ADD);
    expect(more).toEqual([]);
    expect(advice).toBe(
      "the github-actions entry has a cooldown that does not exclude Avunu/docusystem, so a release of the shared workflows would wait for it; add this under its cooldown:\nexclude:\n  - Avunu/docusystem",
    );
  });

  test("the github-actions entry is not judged when the workflows are not set up (no actions)", () => {
    expect(
      cooldownAdvice(file([actionsEntry(COOLDOWN)]), { site: "docs-site", actions: false }),
    ).toEqual([]);
  });

  test("nothing to say about excluded packages, entries without a cooldown, or other folders", () => {
    expect(
      cooldownAdvice(
        file([
          npmEntry(EXCLUDING("@avunu/docusystem")),
          actionsEntry(EXCLUDING("Avunu/docusystem")),
          "  - package-ecosystem: npm\n    directory: /\n" + COOLDOWN,
          "  - package-ecosystem: github-actions\n    directory: /sub\n" + COOLDOWN,
        ]),
        ADD,
      ),
    ).toEqual([]);
    expect(cooldownAdvice(file([npmEntry(""), actionsEntry("")]), ADD)).toEqual([]);
    expect(cooldownAdvice("", ADD)).toEqual([]);
    expect(cooldownAdvice("not: [yaml", ADD)).toEqual([]);
  });

  test("the entries that init writes need no advice", () => {
    expect(cooldownAdvice(ensureDependabotEntries(null, ADD).text, ADD)).toEqual([]);
  });
});

describe("a file that cannot be edited safely", () => {
  const snippetOf = (error: unknown): string => (error as DependabotShapeError).snippet;

  test.each([
    ["not YAML", "version: 2\nupdates: [unclosed\n"],
    ["updates is a string", "version: 2\nupdates: none\n"],
    ["updates is a mapping", "version: 2\nupdates:\n  npm: yes\n"],
    ["an entry is a string", "version: 2\nupdates:\n  - just-text\n"],
    ["an entry has no ecosystem", "version: 2\nupdates:\n  - directory: /\n"],
    ["the top level is a list", "- a\n- b\n"],
  ])("%s: refused, with the snippet to add by hand", (_name, text) => {
    let caught: unknown;
    try {
      ensureDependabotEntries(text, ADD);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DependabotShapeError);
    expect((caught as Error).message).not.toContain("\n");
    expect(snippetOf(caught)).toContain("package-ecosystem: npm");
    expect(snippetOf(caught)).toContain("directory: /docs-site");
    expect(snippetOf(caught)).toContain("package-ecosystem: github-actions");
  });

  test("a site folder the workflow would not accept is an error, not a snippet", () => {
    expect(() => ensureDependabotEntries(null, { site: "../x", actions: false })).toThrow(
      /not a usable site folder/,
    );
  });
});

describe("readDependabotEntries", () => {
  test("reads the cooldown and what it excludes", () => {
    const { entries } = readDependabotEntries(
      "version: 2\nupdates:\n  - package-ecosystem: github-actions\n    directory: /\n    cooldown:\n      default-days: 7\n      exclude: [Avunu/docusystem]\n  - package-ecosystem: npm\n    directory: /\n",
    );
    expect(entries[0]?.cooldown).toEqual({ present: true, excludes: ["Avunu/docusystem"] });
    expect(entries[1]?.cooldown).toEqual({ present: false, excludes: [] });
  });

  test("a file without entries has none, and bad text is an error", () => {
    expect(readDependabotEntries("version: 2\n")).toEqual({ entries: [] });
    expect(readDependabotEntries("").entries).toEqual([]);
    expect(readDependabotEntries("updates: [unclosed").error).toBeDefined();
    expect(readDependabotEntries("updates: yes").error).toContain("not a list");
  });
});

describe("dependabotFile", () => {
  test("the file the repository has: .yml first, then .yaml, else the .yml it would get", () => {
    expect(dependabotFile(makeRepo())).toBe(".github/dependabot.yml");
    expect(dependabotFile(makeRepo({ files: { ".github/dependabot.yaml": "version: 2\n" } }))).toBe(
      ".github/dependabot.yaml",
    );
    expect(
      dependabotFile(
        makeRepo({ files: { ".github/dependabot.yaml": "a", ".github/dependabot.yml": "b" } }),
      ),
    ).toBe(".github/dependabot.yml");
  });
});
