// docs-enhance is the page's one island of JavaScript. Its scrollable-region rule is the 1px fix of
// section 10.3: a code block or table that overflows its box by any amount must be reachable with
// the keyboard (axe `scrollable-region-focusable`), where the starter only counted an overflow of
// more than one pixel. The body of the component is run here on stand-in elements.
import { describe, expect, test } from "vitest";
import { readJson } from "./support/site.js";

const body: string = readJson("components/docs-enhance.json").state.onMount.body;

/** The function `markScrollable` of the island, closed over the elements it looks at. */
function markScrollable(elements: FakeElement[]): () => void {
  const match = /const markScrollable = \(\) => \{[\s\S]*?\n\};/.exec(body);
  expect(match, "docs-enhance has no markScrollable").not.toBeNull();
  return new Function("scrollers", `${match![0]}\nreturn markScrollable;`)(elements) as () => void;
}

class FakeElement {
  attributes = new Map<string, string>();
  constructor(
    public scrollWidth: number,
    public clientWidth: number,
  ) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

describe("code blocks and tables that scroll sideways can be focused", () => {
  test("a region that overflows by a single pixel gets tabindex 0", () => {
    const element = new FakeElement(101, 100);
    markScrollable([element])();
    expect(element.attributes.get("tabindex")).toBe("0");
  });

  test("a region that overflows by more gets tabindex 0 as well", () => {
    const element = new FakeElement(400, 100);
    markScrollable([element])();
    expect(element.attributes.get("tabindex")).toBe("0");
  });

  test("a region that fits has none, and loses it when it stops overflowing", () => {
    const fits = new FakeElement(100, 100);
    const resized = new FakeElement(150, 100);
    const mark = markScrollable([fits, resized]);
    mark();
    expect(fits.attributes.has("tabindex")).toBe(false);
    expect(resized.attributes.get("tabindex")).toBe("0");
    resized.scrollWidth = 100;
    mark();
    expect(resized.attributes.has("tabindex")).toBe(false);
  });

  test("the rule is written without the old tolerance", () => {
    expect(body).toContain("if (el.scrollWidth > el.clientWidth) {");
    expect(body).not.toMatch(/clientWidth\s*\+\s*1/);
  });

  test("the scrollable elements are checked again when the fonts load and when the window is resized", () => {
    expect(body).toContain("document.fonts.ready.then(markScrollable)");
    expect(body).toMatch(/addEventListener\('resize', \(\) => \{ clearTimeout\(resizeTimer\)/);
  });
});
