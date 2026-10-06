// Keyboard and behaviour test of the project switcher in a real browser.
//
//   bun switcher.ts <dist> [route]        (<dist> is <site>/.docusystem/site/dist of a site whose slug is a
//                                         real catalog slug, so that the "You are here" state exists)
//
// Covers: the list is in the HTML before any script runs (snapshot), the live catalog replaces it
// when the fetch succeeds, the snapshot stays when the fetch fails, the current project is marked,
// the disclosure pattern (Enter or Space opens it, focus stays on the button, Tab walks the links and
// out of the list, which closes it, Shift+Tab goes back, Escape closes it and focus is on the
// button), accessible names, light dismiss, no layout shift, reduced motion, and a catalog that is
// bad in some way (an invalid entry, duplicates, a flood, a very long title) which never breaks the list.
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
  configOf,
  defaultDocsRoute,
  launch,
  serve,
  snapshotOf,
  stubCatalog,
  watch,
} from "./lib.ts";

const [distArg, routeGiven] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!distArg) {
  console.error("usage: bun switcher.ts <dist> [route]");
  process.exit(2);
}
const dist = resolve(distArg);
const routeArg = routeGiven ?? defaultDocsRoute(dist);
const snapshotText = snapshotOf(dist);
const snapshot = JSON.parse(snapshotText) as { projects: Array<Record<string, unknown>> };
const slug = configOf(dist).slug;
if (!snapshot.projects.some((p) => p.slug === slug)) {
  console.error(
    `switcher: the slug "${slug}" is not in the bundled catalog, so there is no "You are here" state to test; use a site with a catalog slug`,
  );
  process.exit(2);
}

const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  slug: name,
  title: name,
  platform: "general",
  summary: "x",
  repo: `https://github.com/Avunu/${name}`,
  page: `https://avunu.net/open-source/${name}/`,
  docs: null,
  license: "MIT",
  status: "active",
  suite: null,
  ...extra,
});

// A live catalog that differs from the snapshot: one project gains a docs site, one is new.
const live = structuredClone(snapshot) as {
  projects: Array<Record<string, unknown>>;
  generated: string;
};
live.generated = "2099-01-01T00:00:00Z";
const own = live.projects.find((p) => p.slug === slug);
if (own) own.docs = `https://${slug}.avunu.net`;
live.projects.push(
  entry("brand-new-project", {
    title: "Brand New Project",
    docs: "https://brand-new-project.avunu.net",
  }),
);

let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && detail ? `  (${detail})` : ""}`);
};

const server = serve(dist);
const url = `http://localhost:${server.port}${routeArg}`;
const browser = await launch();

const links = (page: Page) => page.locator("project-switcher .menu a");
const linkText = (page: Page) => links(page).allTextContents();
const isOpen = (page: Page) =>
  page.locator("project-switcher .menu").evaluate((el) => el.matches(":popover-open"));
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el
      ? `${el.tagName.toLowerCase()}|${(el.textContent ?? "").trim().replace(/\s+/g, " ")}`
      : "";
  });
const listed = (page: Page) => links(page).count();

// 1. Before the live catalog answers, the snapshot builds the list; without JavaScript the two
//    avunu.net links still work (the popover opens without script).
{
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(url);
  const items = await listed(page);
  check(
    items === 2,
    "without JavaScript the list still offers the two avunu.net links",
    `${items} items`,
  );
  await page.locator("project-switcher button.trigger").click();
  check(await isOpen(page), "without JavaScript the button still opens the list");
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await stubCatalog(context, null);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  const items = await listed(page);
  check(
    items === snapshot.projects.length + 2,
    "with the fetch failing, the list has every project of the snapshot plus two avunu.net links",
    `${items} items`,
  );
  const labels = await page
    .locator("project-switcher .menu ul")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  check(
    JSON.stringify(labels) ===
      JSON.stringify(["Frappe & ERPNext", "Odoo", "WordPress", "NixOS", "General", "Avunu"]),
    "groups are by platform, in order, then Avunu",
    JSON.stringify(labels),
  );
  const current = await page.locator('project-switcher [aria-current="true"]').allTextContents();
  check(
    current.length === 1 && current[0]!.includes("You are here"),
    "exactly one entry is the current project",
    JSON.stringify(current),
  );
  const back = await page.locator('project-switcher a[href="https://avunu.net/"]').count();
  check(back === 1, "the list has a Back to avunu.net link");
  const roles = await page
    .locator("project-switcher [role=menu], project-switcher [role=menuitem]")
    .count();
  check(roles === 0, "it is a disclosure of links: no menu or menuitem roles");
  const popoverOf = await page
    .locator("project-switcher button.trigger")
    .evaluate((b) => b.getAttribute("aria-haspopup"));
  check(popoverOf === null, "the button does not claim a menu (no aria-haspopup)");
  // The name of a link is its title, then the caption, with a comma between them.
  const named = await page
    .getByRole("link", { name: "Automated Subscriptions, avunu.net", includeHidden: true })
    .count();
  check(named === 1, "a link's accessible name is its title and its caption, with a separator");
  await context.close();
}

// 2. Live catalog replaces the snapshot; no layout shift on the page or the button.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await stubCatalog(context, JSON.stringify(live));
  const page = await context.newPage();
  const probe = watch(page);
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as Array<{
        value: number;
        hadRecentInput: boolean;
      }>)
        if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const button = page.locator("project-switcher button.trigger");
  const before = await button.boundingBox();
  const heightBefore = await page.evaluate(() => document.documentElement.scrollHeight);
  const items = await linkText(page);
  check(
    items.some((t) => t.includes("Brand New Project")),
    "the live catalog is swapped in after load",
  );
  check(
    items.length === live.projects.length + 2,
    "the live catalog replaces the snapshot entries",
    `${items.length} items`,
  );
  const own = await page.locator('project-switcher [aria-current="true"]').getAttribute("href");
  check(
    own === `https://${slug}.avunu.net`,
    "the current project links to its docs site once the catalog says it has one",
    String(own),
  );
  const newHref = await page
    .locator('project-switcher a:has-text("Brand New Project")')
    .getAttribute("href");
  check(
    newHref === "https://brand-new-project.avunu.net",
    "an entry with docs links to its docs site",
    String(newHref),
  );
  const noDocs = await page
    .locator('project-switcher a:has-text("Automated Subscriptions")')
    .getAttribute("href");
  check(
    noDocs === "https://avunu.net/open-source/automated_subscriptions/",
    "an entry without docs links to its avunu.net page",
    String(noDocs),
  );

  // 3. Keyboard: the disclosure pattern.
  await button.focus();
  check((await button.getAttribute("aria-expanded")) === "false", "the button starts collapsed");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check((await button.getAttribute("aria-expanded")) === "true", "Enter on the button opens it");
  check(await isOpen(page), "the list is a popover and is open");
  check(
    (await focused(page)).startsWith("button|"),
    "focus stays on the button when it opens",
    await focused(page),
  );
  await page.keyboard.press("Tab");
  const first = await focused(page);
  check(first.startsWith("a|"), "Tab goes into the first link of the list", first);
  await page.keyboard.press("Tab");
  const second = await focused(page);
  check(second !== first && second.startsWith("a|"), "Tab moves to the next link", second);
  await page.keyboard.press("Shift+Tab");
  check((await focused(page)) === first, "Shift+Tab moves back");
  const grid = await page.locator("project-switcher .menu").boundingBox();
  const vp = page.viewportSize()!;
  check(
    !!grid && grid.x >= 0 && grid.x + grid.width <= vp.width && grid.y >= 0,
    "the open list stays inside the viewport",
    JSON.stringify(grid),
  );
  const afterOpen = await button.boundingBox();
  check(
    JSON.stringify(before) === JSON.stringify(afterOpen),
    "opening the list does not move the button",
  );
  check(
    (await page.evaluate(() => document.documentElement.scrollHeight)) === heightBefore,
    "opening the list does not change the page height",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check((await button.getAttribute("aria-expanded")) === "false", "Escape closes the list");
  check(
    (await focused(page)).startsWith("button|Projects"),
    "Escape from a link returns focus to the button",
    await focused(page),
  );
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  check((await button.getAttribute("aria-expanded")) === "true", "Space on the button opens it");
  // Tab through every link: the last Tab leaves the list, which closes it.
  const count = await listed(page);
  for (let i = 0; i < count; i++) await page.keyboard.press("Tab");
  check(
    (await focused(page)).includes("Back to avunu.net"),
    "Tab reaches the last link after as many presses as there are links",
    await focused(page),
  );
  check(await isOpen(page), "the list is still open on its last link");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  check((await button.getAttribute("aria-expanded")) === "false", "Tab out of the list closes it");
  const afterTab = await focused(page);
  check(!afterTab.startsWith("a|Back"), "Tab leaves the list", afterTab);
  await button.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.mouse.click(700, 500);
  await page.waitForTimeout(200);
  check(
    (await button.getAttribute("aria-expanded")) === "false",
    "clicking outside closes the list",
  );

  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  check(
    cls < 0.02,
    "cumulative layout shift stays under 0.02 across load, catalog swap and use of the list",
    String(cls),
  );
  check(
    probe.consoleErrors.length === 0,
    "no console errors with a healthy catalog",
    JSON.stringify(probe.consoleErrors),
  );
  await context.close();
}

// 4. The fetch fails: the snapshot carries the list and the keyboard still works.
{
  const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await stubCatalog(context, null);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const items = await listed(page);
  check(
    items === snapshot.projects.length + 2,
    "when the fetch fails the snapshot stays",
    `${items} items`,
  );
  await page.locator("project-switcher button.trigger").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check(await isOpen(page), "the list opens with the keyboard at 390px");
  const box = await page.locator("project-switcher .menu").boundingBox();
  check(
    !!box && box.x >= 0 && box.x + box.width <= 390,
    "the list fits a phone screen",
    JSON.stringify(box),
  );
  await context.close();
}

// 5. Malformed catalogs are ignored; a catalog that is bad in part is used for the rest.
{
  for (const [name, body] of [
    ["the wrong version", JSON.stringify({ ...live, version: 2 })],
    ["not JSON", "<html>"],
    [
      "made of unsafe links",
      JSON.stringify({
        version: 1,
        projects: [
          { slug: "x", title: "X", platform: "general", page: "javascript:alert(1)", docs: null },
        ],
      }),
    ],
    ["larger than the limit", JSON.stringify({ ...live, pad: "x".repeat(300_000) })],
  ] as const) {
    const context = await browser.newContext();
    await stubCatalog(context, body);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    check(
      (await listed(page)) === snapshot.projects.length + 2,
      `a catalog that is ${name} is ignored`,
    );
    await context.close();
  }
  const hostile = {
    version: 1,
    generated: "2099-01-01T00:00:00Z",
    site: "https://avunu.net",
    projects: [
      { slug: "bad-entry", title: null, platform: "general" },
      entry("good-one", { title: "Good One" }),
      entry("good-one", { title: "Second With The Same Slug" }),
      entry("blank", { title: "   " }),
      entry("constructor-platform", { platform: "constructor", title: "Constructor Platform" }),
      entry("long-title", { title: "W".repeat(140) }),
      entry(slug, { title: "Current" }),
    ],
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await stubCatalog(context, JSON.stringify(hostile));
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const texts = await linkText(page);
  check(
    texts.some((t) => t.includes("Good One")) && !texts.some((t) => t.includes("Second With")),
    "an invalid entry does not discard the catalog, and a duplicate slug keeps the first entry",
    JSON.stringify(texts.slice(0, 5)),
  );
  check(
    !texts.some((t) => t.trim().startsWith("avunu.net") || t.trim() === "") &&
      texts.some((t) => t.includes("Constructor Platform")),
    "an entry with a blank title is dropped, a platform named like an Object property is a group",
  );
  check(
    (await page.locator('project-switcher [aria-current="true"]').count()) === 1,
    "one current project",
  );
  await page.locator("project-switcher button.trigger").click();
  await page.waitForTimeout(250);
  const overflow = await page
    .locator("project-switcher .menu")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  check(
    overflow <= 0,
    "a very long title does not make the list scroll sideways",
    String(overflow),
  );
  await context.close();

  const flood = {
    ...live,
    // Small entries, so the flood is under the size limit and it is the count that is cut.
    projects: Array.from({ length: 1500 }, (_v, i) => ({
      slug: `flood-${i}`,
      title: `Flood ${i}`,
      platform: "odoo",
      page: `https://avunu.net/p/${i}/`,
    })),
  };
  const floodContext = await browser.newContext();
  await stubCatalog(floodContext, JSON.stringify(flood));
  const floodPage = await floodContext.newPage();
  await floodPage.goto(url, { waitUntil: "networkidle" });
  await floodPage.waitForTimeout(400);
  const flooded = await listed(floodPage);
  check(
    flooded === 302,
    "a catalog of 1500 entries is cut at 300 (plus two avunu.net links)",
    String(flooded),
  );
  await floodContext.close();
}

// 6. Reduced motion: no animation on the list.
{
  const context = await browser.newContext({ reducedMotion: "reduce" });
  await stubCatalog(context, snapshotText);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  const duration = await page
    .locator("project-switcher .menu")
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  const seconds = duration.split(",").map((d) => Number.parseFloat(d));
  check(
    seconds.every((n) => n < 0.001),
    "reduced motion: the list has no transition",
    duration,
  );
  await context.close();
}

await browser.close();
server.stop();
console.log(
  failures === 0 ? "switcher: all checks passed" : `switcher: ${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
