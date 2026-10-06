// Screenshots of the interactive states: the project menu open, the search palette with a query, the
// mobile navigation drawer, and the inline table of contents on a narrow screen.
//
//   bun states.ts <dist> <outDir> [route] [search query]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultDocsRoute, launch, serve, snapshotOf, stubCatalog } from "./lib.ts";

const [distArg, outArg, routeGiven, query = "configuration"] = process.argv.slice(2);
if (!distArg || !outArg) {
  console.error("usage: bun states.ts <dist> <outDir> [route] [query]");
  process.exit(2);
}
const dist = resolve(distArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const route = routeGiven ?? defaultDocsRoute(dist);
const snapshot = snapshotOf(dist);
const server = serve(dist);
const browser = await launch();
const base = `http://localhost:${server.port}`;

for (const scheme of ["light", "dark"] as const) {
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  await stubCatalog(desktop, snapshot);
  const page = await desktop.newPage();
  await page.goto(base + route, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.locator("project-switcher button.trigger").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `switcher-1440-${scheme}.png`) });
  await page.keyboard.press("Escape");
  await page.locator("docs-search button[data-variant]").click();
  await page.waitForTimeout(500);
  await page.keyboard.type(query, { delay: 30 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `search-1440-${scheme}.png`) });
  await desktop.close();

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: scheme,
  });
  await stubCatalog(phone, snapshot);
  const m = await phone.newPage();
  await m.goto(base + route, { waitUntil: "networkidle" });
  await m.waitForTimeout(300);
  await m.locator("project-switcher button.trigger").click();
  await m.waitForTimeout(400);
  await m.screenshot({ path: join(out, `switcher-390-${scheme}.png`) });
  await m.keyboard.press("Escape");
  await m.locator(".menu-btn").click();
  await m.waitForTimeout(400);
  await m.screenshot({ path: join(out, `drawer-390-${scheme}.png`) });
  await m.keyboard.press("Escape");
  if ((await m.locator("details.toc-inline > summary").count()) > 0) {
    await m.locator("details.toc-inline > summary").click();
    await m.waitForTimeout(200);
    await m.screenshot({ path: join(out, `toc-390-${scheme}.png`) });
  }
  await phone.close();
}
await browser.close();
server.stop();
console.log(`states: screenshots written to ${out}`);
