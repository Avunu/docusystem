import { describe, expect, test } from "vitest";
import * as api from "../../src/index.js";
import { WORKFLOW_CONTRACT, name, version } from "../../src/lib/package-info.js";
import { PLATFORMS } from "../../src/lib/platforms.js";

describe("the programmatic surface (section 4.3)", () => {
  test("exports exactly PLATFORMS, readConfig, validateConfig, name, version and WORKFLOW_CONTRACT", () => {
    // Types (Platform, DocsConfig) are erased; everything else that is exported is semver surface.
    expect(Object.keys(api).sort()).toEqual(
      ["PLATFORMS", "WORKFLOW_CONTRACT", "name", "readConfig", "validateConfig", "version"].sort(),
    );
  });

  test("the values are the package's own", () => {
    expect(api.PLATFORMS).toBe(PLATFORMS);
    expect(api.name).toBe(name);
    expect(api.version).toBe(version);
    expect(api.WORKFLOW_CONTRACT).toBe(WORKFLOW_CONTRACT);
    expect(typeof api.readConfig).toBe("function");
    expect(typeof api.validateConfig).toBe("function");
  });
});
