import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  NODE_FLOOR,
  REPOSITORY,
  WORKFLOW_CONTRACT,
  major,
  name,
  packageRoot,
  version,
} from "../../src/lib/package-info.js";
import { PLATFORMS } from "../../src/lib/platforms.js";
import { REPO_ROOT } from "../support/index.js";

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  engines: { node: string };
  repository: { url: string };
};

describe("package-info", () => {
  test("name, version and major come from the package's own package.json", () => {
    expect(name).toBe("@avunu/docusystem");
    expect(name).toBe(pkg.name);
    expect(version).toBe(pkg.version);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(major).toBe(Number.parseInt(pkg.version.split(".")[0] ?? "", 10));
  });

  test("packageRoot is the folder with package.json, whether the code runs from src/ or dist/", () => {
    expect(packageRoot).toBe(REPO_ROOT);
    expect(packageRoot.endsWith("/")).toBe(false);
  });

  test("the Node floor is the one the engines field declares", () => {
    expect(NODE_FLOOR).toBe("22.19.0");
    expect(pkg.engines.node).toBe(`>=${NODE_FLOOR}`);
  });

  test("the repository is the one package.json points at", () => {
    expect(REPOSITORY).toBe("Avunu/docusystem");
    expect(pkg.repository.url).toBe(`git+https://github.com/${REPOSITORY}.git`);
  });

  test("the workflow contract is a positive integer", () => {
    expect(Number.isInteger(WORKFLOW_CONTRACT)).toBe(true);
    expect(WORKFLOW_CONTRACT).toBeGreaterThanOrEqual(1);
  });
});

describe("platforms", () => {
  test("are the five of the config schema, in this order", () => {
    expect([...PLATFORMS]).toEqual(["frappe", "odoo", "wordpress", "nixos", "general"]);
  });
});
