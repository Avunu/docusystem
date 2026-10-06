// axe-core on every page at three widths in both colour schemes (WCAG 2.0/2.1 A and AA plus best
// practices), and again with each overlay open: the project list, the search palette (empty, then
// with results), and on narrow screens the navigation drawer. Everything an overlay shows is
// invisible to a scan of the closed page, so the states are scanned too. Exits 1 on any serious or
// critical violation; moderate and minor ones are listed.
//
//   bun axe.ts <dist> [route ...]        (<dist> is <site>/.docusystem/site/dist)
//
// The overlays are opened on the documentation pages among the routes (the first two), not on every
// page: they are the same components everywhere.
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright-core";
import { SCHEMES, WIDTHS, launch, routesOf, serve, snapshotOf, stubCatalog } from "./lib.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [distArg, ...routeArgs] = args;
if (!distArg) {
  console.error("usage: bun axe.ts <dist> [route ...]");
  process.exit(2);
}
const dist = resolve(distArg);
const routes = routeArgs.length > 0 ? routeArgs : routesOf(dist);
const server = serve(dist);
const browser = await launch();
const snapshot = snapshotOf(dist);

/** A word that is in the search index, so the palette has results. */
async function queryWord(): Promise<string> {
  try {
    const index = JSON.parse(await Bun.file(join(dist, "search-index.json")).text()) as {
      documents?: Array<{ title?: string }>;
    };
    const words = (index.documents ?? []).flatMap(
      (d) => (d.title ?? "").match(/[A-Za-z]{5,}/g) ?? [],
    );
    return words[0] ?? "documentation";
  } catch {
    return "documentation";
  }
}
const query = await queryWord();
const overlayRoutes = routes.filter((r) => r.startsWith("/docs/")).slice(0, 2);

let blocking = 0;
let other = 0;
let runs = 0;

async function scan(page: Page, label: string, scheme: string, width: number, route: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  runs++;
  for (const v of result.violations) {
    const serious = v.impact === "serious" || v.impact === "critical";
    if (serious) blocking++;
    else other++;
    console.log(
      `${serious ? "VIOLATION" : "note     "} [${v.impact}] ${v.id} ${scheme} ${width} ${route} (${label}): ${v.help}`,
    );
    for (const n of v.nodes.slice(0, 3))
      console.log(
        `    ${n.target.join(" ")}  ${(n.failureSummary ?? "").split("\n").slice(0, 2).join(" | ")}`,
      );
  }
}

async function overlays(page: Page, scheme: string, width: number, route: string) {
  const expect = async (open: boolean, what: string) => {
    if (!open) {
      blocking++;
      console.log(`VIOLATION [setup] ${what} did not open ${scheme} ${width} ${route}`);
    }
    return open;
  };
  // the project list
  await page.locator("project-switcher button.trigger").click();
  await page.waitForTimeout(300);
  if (
    await expect(
      await page.locator("project-switcher .menu").evaluate((e) => e.matches(":popover-open")),
      "the project list",
    )
  )
    await scan(page, "project list open", scheme, width, route);
  await page.keyboard.press("Escape");
  // the search palette, empty and with results
  await page.locator("docs-search button[data-variant]").click();
  await page.waitForTimeout(500);
  if (
    await expect(
      await page.locator("#site-search-modal").evaluate((e) => e.matches(":popover-open")),
      "the search palette",
    )
  ) {
    await scan(page, "search open, no query", scheme, width, route);
    await page.keyboard.type(query, { delay: 20 });
    await page
      .waitForSelector("#site-search-listbox [role=option]", { timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(300);
    await expect(
      (await page.locator("#site-search-listbox [role=option]").count()) > 0,
      "search results for the query",
    );
    await scan(page, "search open, with results", scheme, width, route);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  // the navigation drawer, where there is one
  if (width < 960) {
    await page.locator(".menu-btn").click();
    await page.waitForTimeout(300);
    if (
      await expect(
        await page.locator("#docs-drawer").evaluate((e) => e.matches(":popover-open")),
        "the drawer",
      )
    )
      await scan(page, "drawer open", scheme, width, route);
    await page.keyboard.press("Escape");
  }
}

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: scheme,
    });
    await stubCatalog(context, snapshot);
    for (const route of routes) {
      const page = await context.newPage();
      await page.goto(`http://localhost:${server.port}${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(200);
      await scan(page, "closed", scheme, width, route);
      if (overlayRoutes.includes(route)) await overlays(page, scheme, width, route);
      await page.close();
    }
    await context.close();
  }
}
await browser.close();
server.stop();
console.log(
  `axe: ${runs} page run(s) (closed pages and open overlays), ${blocking} serious/critical, ${other} moderate/minor`,
);
process.exit(blocking === 0 ? 0 : 1);
