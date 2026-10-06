import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ejectableFiles, ejectFile, overrideFindings } from "../../src/lib/overrides.js";
import { version } from "../../src/lib/package-info.js";
import { sha256 } from "../../src/lib/fsutil.js";
import { at, listTree, tempDir, writeTree } from "../support/index.js";
import { SITE_SOURCE, copySite } from "./helpers.js";

const FOOTER = "components/docs-footer.json";
const record = (siteDir: string): Record<string, { from: string; sha256: string }> =>
  JSON.parse(readFileSync(join(siteDir, "overrides", ".ejected.json"), "utf8"));
const eject = (siteDir: string, rel: string, o: { force?: boolean } = {}) =>
  ejectFile(siteDir, rel, { ...o, siteSource: SITE_SOURCE });
const findings = (siteDir: string, siteSource = SITE_SOURCE) =>
  overrideFindings(siteDir, { siteSource });

describe("ejectableFiles", () => {
  test("lists the Jx files of the package that an override can replace, sorted", () => {
    expect(ejectableFiles(SITE_SOURCE)).toEqual([
      "components/docs-callout.json",
      "components/docs-footer.json",
      "layouts/base.json",
      "layouts/docs.json",
      "pages/404.json",
      "pages/[...path].json",
      "pages/index.json",
    ]);
  });
});

describe("ejectFile", () => {
  test("copies the package file into overrides/ and records version and checksum", () => {
    const site = tempDir();
    const { to } = eject(site, FOOTER);
    expect(to).toBe(join(site, "overrides", "components", "docs-footer.json"));
    expect(readFileSync(to)).toEqual(readFileSync(at(SITE_SOURCE, FOOTER)));
    expect(record(site)).toEqual({
      [FOOTER]: { from: version, sha256: sha256(at(SITE_SOURCE, FOOTER)) },
    });
    expect(readFileSync(join(site, "overrides", ".ejected.json"), "utf8")).toMatch(/\n$/);
    expect(listTree(site)).toEqual([
      "overrides/",
      "overrides/.ejected.json",
      "overrides/components/",
      "overrides/components/docs-footer.json",
    ]);
  });

  test("keeps the other records and sorts them", () => {
    const site = tempDir();
    eject(site, "pages/index.json");
    eject(site, "components/docs-callout.json");
    eject(site, "layouts/base.json");
    expect(Object.keys(record(site))).toEqual([
      "components/docs-callout.json",
      "layouts/base.json",
      "pages/index.json",
    ]);
  });

  test("ejects layouts and pages, brackets in the name included", () => {
    const site = tempDir();
    eject(site, "pages/[...path].json");
    expect(existsSync(join(site, "overrides", "pages", "[...path].json"))).toBe(true);
    expect(Object.keys(record(site))).toEqual(["pages/[...path].json"]);
  });

  test("an override that exists is not replaced without force, and nothing changes", () => {
    const site = tempDir();
    eject(site, FOOTER);
    const mine = join(site, "overrides", "components", "docs-footer.json");
    writeFileSync(mine, '{"mine":true}');
    const before = listTree(site);
    expect(() => eject(site, FOOTER)).toThrow(
      "overrides/components/docs-footer.json exists already: nothing was changed (use --force to replace it with the package's file)",
    );
    expect(readFileSync(mine, "utf8")).toBe('{"mine":true}');
    expect(listTree(site)).toEqual(before);
  });

  test("force replaces the override and refreshes its record", () => {
    const site = tempDir();
    eject(site, FOOTER);
    writeFileSync(
      join(site, "overrides", ".ejected.json"),
      JSON.stringify({ [FOOTER]: { from: "0.0.1", sha256: "0".repeat(64) } }),
    );
    writeFileSync(join(site, "overrides", FOOTER), '{"mine":true}');
    eject(site, FOOTER, { force: true });
    expect(readFileSync(join(site, "overrides", FOOTER))).toEqual(
      readFileSync(at(SITE_SOURCE, FOOTER)),
    );
    expect(record(site)[FOOTER]).toEqual({
      from: version,
      sha256: sha256(at(SITE_SOURCE, FOOTER)),
    });
  });

  test("a hand-made override that exists blocks the eject too, and force takes it over", () => {
    const site = tempDir();
    writeTree(site, { [`overrides/${FOOTER}`]: "{}" });
    expect(() => eject(site, FOOTER)).toThrow(/exists already/);
    eject(site, FOOTER, { force: true });
    expect(Object.keys(record(site))).toEqual([FOOTER]);
  });

  test.each([
    ["a file the package does not ship", "components/docs-nope.json"],
    ["a path outside the three folders", "public/favicon.svg"],
    ["the project file", "project.base.json"],
    ["a folder", "components"],
    ["a folder with a slash", "components/"],
    ["a nested component", "components/sub/docs-footer.json"],
    ["a parent folder", "components/../layouts/base.json"],
    ["a parent folder at the start", "../components/docs-footer.json"],
    ["an absolute path", "/etc/passwd"],
    ["a dot part", "components/./docs-footer.json"],
    ["a backslash", "components\\docs-footer.json"],
    ["an empty rel", ""],
    ["a leading ./", "./components/docs-footer.json"],
  ])("%s is refused with the list of what can be ejected, and writes nothing", (_what, rel) => {
    const site = tempDir();
    let message = "";
    try {
      eject(site, rel);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      `${JSON.stringify(rel)} is not a file that the installed package ships`,
    );
    expect(message).toContain("components/docs-footer.json");
    expect(listTree(site)).toEqual([]);
  });

  test("an unknown file names only the files of its own folder", () => {
    const site = tempDir();
    expect(() => eject(site, "pages/nope.json")).toThrow(
      "not a file that the installed package ships: name one of pages/404.json, pages/[...path].json, pages/index.json",
    );
  });

  test("an overrides folder that is a symbolic link is refused: ejecting writes", () => {
    const site = tempDir();
    const elsewhere = tempDir();
    symlinkSync(elsewhere, join(site, "overrides"));
    expect(() => eject(site, FOOTER)).toThrow(/symbolic link/);
    expect(listTree(elsewhere)).toEqual([]);
  });

  test("an override sub-folder that is a symbolic link is refused too", () => {
    const site = tempDir();
    const elsewhere = tempDir();
    mkdirSync(join(site, "overrides"));
    symlinkSync(elsewhere, join(site, "overrides", "components"));
    expect(() => eject(site, FOOTER)).toThrow(/symbolic link/);
    expect(listTree(elsewhere)).toEqual([]);
  });

  test("a record that is not valid JSON stops the eject, and the override is not written", () => {
    const site = tempDir();
    writeTree(site, { "overrides/.ejected.json": "{ nope" });
    expect(() => eject(site, FOOTER)).toThrow(/overrides\/\.ejected\.json is not valid JSON/);
    expect(existsSync(join(site, "overrides", "components"))).toBe(false);
  });

  test("a record that is not an object stops the eject", () => {
    const site = tempDir();
    writeTree(site, { "overrides/.ejected.json": "[]" });
    expect(() => eject(site, FOOTER)).toThrow(/must be a JSON object/);
  });
});

describe("overrideFindings", () => {
  test("a site without overrides has no findings", () => {
    expect(findings(tempDir())).toEqual([]);
    const empty = tempDir();
    mkdirSync(join(empty, "overrides"));
    expect(findings(empty)).toEqual([]);
  });

  test("current: the package file is the one that was copied", () => {
    const site = tempDir();
    eject(site, FOOTER);
    expect(findings(site)).toEqual([
      {
        level: "ok",
        message: `overrides/${FOOTER} is current with the package's file (copied from ${version})`,
      },
    ]);
  });

  test("editing the override is not drift", () => {
    const site = tempDir();
    eject(site, FOOTER);
    writeFileSync(join(site, "overrides", FOOTER), '{"edited":true}');
    expect(findings(site).map((f) => f.level)).toEqual(["ok"]);
  });

  test("changed: the package file differs from the one that was copied", () => {
    const site = tempDir();
    eject(site, FOOTER);
    const newer = copySite();
    writeFileSync(join(newer, FOOTER), '{"tagName":"docs-footer","newer":true}');
    const [finding, ...rest] = findings(site, newer);
    expect(rest).toEqual([]);
    expect(finding?.level).toBe("warning");
    expect(finding?.message).toContain(
      `overrides/${FOOTER}: copied from ${version}, package file changed`,
    );
    expect(finding?.message).toContain(`node_modules/@avunu/docusystem/site/${FOOTER}`);
  });

  test("not ejected: a replacement made by hand cannot be checked for drift", () => {
    const site = tempDir();
    writeTree(site, { [`overrides/${FOOTER}`]: "{}" });
    expect(findings(site)).toEqual([
      {
        level: "warning",
        message:
          `overrides/${FOOTER} replaces a package file but was not made with docusystem eject: nothing tells ` +
          `whether the package's file has changed since (diff it against node_modules/@avunu/docusystem/site/${FOOTER})`,
      },
    ]);
  });

  test("stale: the record names a file the installed package no longer ships", () => {
    const site = tempDir();
    eject(site, FOOTER);
    const newer = copySite();
    rmSync(join(newer, FOOTER));
    const [finding, ...rest] = findings(site, newer);
    expect(rest).toEqual([]);
    expect(finding?.level).toBe("error");
    expect(finding?.message).toContain(`overrides/${FOOTER} was copied from ${version}`);
    expect(finding?.message).toContain(`no longer ships ${FOOTER}`);
  });

  test("a file the package does not ship and the record does not know is an addition: no finding", () => {
    const site = tempDir();
    writeTree(site, {
      "overrides/pages/about.json": "{}",
      "overrides/components/my-badge.json": "{}",
      "overrides/layouts/extra/wide.json": "{}",
    });
    expect(findings(site)).toEqual([]);
  });

  test("an entry of the record whose override is gone is ignored", () => {
    const site = tempDir();
    eject(site, FOOTER);
    rmSync(join(site, "overrides", FOOTER));
    expect(findings(site)).toEqual([]);
    const newer = copySite();
    rmSync(join(newer, FOOTER));
    expect(findings(site, newer)).toEqual([]);
  });

  test("dotfiles and files outside components/, layouts/ and pages/ are not overrides", () => {
    const site = tempDir();
    writeTree(site, {
      "overrides/components/.DS_Store": "x",
      "overrides/project.json": "{}",
      "overrides/misc/docs-footer.json": "{}",
    });
    expect(findings(site)).toEqual([]);
  });

  test("reports every override, in path order", () => {
    const site = tempDir();
    eject(site, "pages/index.json");
    eject(site, "components/docs-callout.json");
    writeTree(site, { "overrides/layouts/base.json": "{}" });
    expect(findings(site).map((f) => `${f.level} ${f.message.split(" ")[0]}`)).toEqual([
      "ok overrides/components/docs-callout.json",
      "warning overrides/layouts/base.json",
      "ok overrides/pages/index.json",
    ]);
  });

  test("a symbolic link to an override file is an override by name", () => {
    const site = tempDir();
    const target = join(tempDir(), "footer.json");
    writeFileSync(target, "{}");
    mkdirSync(join(site, "overrides", "components"), { recursive: true });
    symlinkSync(target, join(site, "overrides", "components", "docs-footer.json"));
    expect(findings(site).map((f) => f.level)).toEqual(["warning"]);
  });

  test("a record that is not valid JSON is one error, not a warning for every override", () => {
    const site = tempDir();
    writeTree(site, { "overrides/.ejected.json": "{ nope", [`overrides/${FOOTER}`]: "{}" });
    const result = findings(site);
    expect(result).toHaveLength(1);
    expect(result[0]?.level).toBe("error");
    expect(result[0]?.message).toContain("overrides/.ejected.json is not valid JSON");
  });

  test("a malformed entry is an error and is not also reported as not ejected", () => {
    const site = tempDir();
    writeTree(site, {
      "overrides/.ejected.json": JSON.stringify({
        [FOOTER]: { from: version },
        "layouts/base.json": { from: version, sha256: "xyz" },
        "pages/index.json": "text",
      }),
      [`overrides/${FOOTER}`]: "{}",
      "overrides/layouts/base.json": "{}",
      "overrides/pages/index.json": "{}",
    });
    const result = findings(site);
    expect(result.map((f) => f.level)).toEqual(["error", "error", "error"]);
    expect(
      result.every((f) => f.message.startsWith("overrides/.ejected.json: the entry for ")),
    ).toBe(true);
  });
});
