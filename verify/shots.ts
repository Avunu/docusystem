// Screenshots of a built site at 1440, 768 and 390 pixels wide, in the light and the dark scheme.
// Prints the page title, horizontal overflow, console errors and failed requests for each.
//
//   bun shots.ts <dist> <outDir> [route ...]      (default routes: every page in the sitemap)
//   (<dist> is <site>/.docusystem/site/dist; the screenshots are for a person to look at, nothing is compared)
//   bun shots.ts <dist> <outDir> --offline        (the projects.json fetch fails: the snapshot must carry the menu)
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SCHEMES,
  WIDTHS,
  launch,
  routesOf,
  serve,
  slugOf,
  snapshotOf,
  stubCatalog,
  watch,
} from "./lib.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const offline = process.argv.includes("--offline");
const [distArg, outArg, ...routeArgs] = args;
if (!distArg || !outArg) {
  console.error("usage: bun shots.ts <dist> <outDir> [route ...] [--offline]");
  process.exit(2);
}
const dist = resolve(distArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const routes = routeArgs.length > 0 ? routeArgs : routesOf(dist);
const server = serve(dist);
const browser = await launch();
let problems = 0;
const snapshot = snapshotOf(dist);
for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: scheme,
    });
    await stubCatalog(context, offline ? null : snapshot);
    for (const route of routes) {
      const page = await context.newPage();
      const probe = watch(page);
      await page.goto(`http://localhost:${server.port}${route}`, { waitUntil: "networkidle" });
      // Lazy images below the fold only load when scrolled to; bring each into view before the shot.
      await page.evaluate(async () => {
        const lazy = Array.from(
          document.querySelectorAll("img[loading=lazy]"),
        ) as HTMLImageElement[];
        for (const img of lazy) {
          img.scrollIntoView({ behavior: "instant" });
          await new Promise((r) => setTimeout(r, 40));
        }
        await Promise.all(lazy.map((img) => img.decode().catch(() => undefined)));
        window.scrollTo({ top: 0, behavior: "instant" });
      });
      await page.waitForTimeout(300);
      const file = join(out, `${slugOf(route)}-${width}-${scheme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const m = await page.evaluate(() => ({
        title: document.title,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        h1: document.querySelectorAll("h1").length,
      }));
      const failed = probe.failedRequests.filter((r) => !(offline && r.includes("/projects.json")));
      const errors = probe.consoleErrors.filter(
        (e) => !(offline && /projects\.json|ERR_FAILED/.test(e)),
      );
      const bad = m.overflow || m.h1 !== 1 || failed.length > 0 || errors.length > 0;
      if (bad) problems++;
      console.log(
        `${bad ? "PROBLEM" : "ok     "} ${scheme} ${width} ${route}  h1=${m.h1} overflow=${m.overflow}${errors.length ? ` errors=${JSON.stringify(errors)}` : ""}${failed.length ? ` failed=${JSON.stringify(failed)}` : ""}`,
      );
      await page.close();
    }
    await context.close();
  }
}
await browser.close();
server.stop();
console.log(problems === 0 ? "shots: OK" : `shots: ${problems} page(s) with problems`);
process.exit(problems === 0 ? 0 : 1);
