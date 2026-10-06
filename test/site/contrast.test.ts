// The contrast gate (WP4, `check` step 15) reads two things from site/: the resolved tokens of
// project.base.json and the search highlight rule of components/docs-search.json. This holds the
// shipped values to the gate: every colour pair of the two themes meets WCAG AA, and a theme
// override that breaks it is caught. Until contrast.ts is real code (it is a WP0 stub, see
// support/stubs.ts) the checks are skipped; they run by themselves after WP4 is merged.
import { describe, expect, test } from "vitest";
import { contrastFailures, highlightOf } from "../../src/lib/contrast.js";
import { implemented } from "./support/stubs.js";
import { PROJECT, readJson, type Json } from "./support/site.js";

const searchStyle = readJson("components/docs-search.json").style as Json;

describe.skipIf(!implemented(() => highlightOf(undefined)))(
  "the shipped tokens and the search highlight meet WCAG AA in both themes",
  () => {
    test("the highlight is read from the component as a 22 percent tint of the action colour", () => {
      expect(highlightOf(searchStyle["& .hl"])).toEqual({
        token: "--color-action",
        percent: 22,
        text: ["--color-text"],
      });
    });

    test("no pair fails, and the pairs are all there", () => {
      const highlight = highlightOf(searchStyle["& .hl"]);
      const { checked, failures } = contrastFailures(PROJECT.style, highlight);
      expect(checked).toBeGreaterThan(140);
      expect(failures).toEqual([]);
    });

    test("a theme override that is too light for the page is caught, a dark enough one is not", () => {
      const highlight = highlightOf(searchStyle["& .hl"]);
      const light = contrastFailures({ ...PROJECT.style, "--color-action": "#C9B8FF" }, highlight);
      expect(light.failures.length).toBeGreaterThan(0);
      const dark = contrastFailures({ ...PROJECT.style, "--color-action": "#4B2A99" }, highlight);
      expect(dark.failures).toEqual([]);
    });
  },
);
