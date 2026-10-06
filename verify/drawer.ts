// The mobile navigation drawer is modal while it is open: focus moves into it, Tab cannot reach the
// page behind it, the opener says it is expanded, Escape closes it and focus is back on the opener,
// and a click outside dismisses it.
//
//   bun drawer.ts <dist> [route]
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import { defaultDocsRoute, launch, serve, snapshotOf, stubCatalog } from "./lib.ts";

const [distArg, routeArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!distArg) {
  console.error("usage: bun drawer.ts <dist> [route]");
  process.exit(2);
}
const dist = resolve(distArg);
const route = routeArg ?? defaultDocsRoute(dist);
const snapshot = snapshotOf(dist);
let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && detail ? `  (${detail})` : ""}`);
};

const server = serve(dist);
const browser = await launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await stubCatalog(context, snapshot);
const page = await context.newPage();
await page.goto(`http://localhost:${server.port}${route}`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);

const where = (p: Page) =>
  p.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "none";
    const inDrawer = !!el.closest("#docs-drawer");
    return `${inDrawer ? "drawer" : "page"}:${el.tagName.toLowerCase()}.${el.className}`;
  });
const opener = page.locator(".menu-btn");
check((await opener.getAttribute("aria-expanded")) === "false", "the opener starts collapsed");
await opener.focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check((await opener.getAttribute("aria-expanded")) === "true", "the opener says it is expanded");
check(
  (await where(page)).startsWith("drawer:button.drawer-close"),
  "focus moves to the close button",
  await where(page),
);
check(
  (await page.locator("#docs-drawer").getAttribute("aria-modal")) === "true",
  "the drawer is marked modal",
);
const inert = await page.evaluate(() =>
  ["main", "docs-header", ".mobile-bar", "docs-footer"].map(
    (s) => document.querySelector(s)?.hasAttribute("inert") ?? false,
  ),
);
check(inert.every(Boolean), "the page behind it is inert", JSON.stringify(inert));
const seen = new Set<string>();
for (let i = 0; i < 40; i++) {
  await page.keyboard.press("Tab");
  seen.add(await where(page));
}
const outside = [...seen].filter((s) => s.startsWith("page:") && !s.startsWith("page:body"));
check(
  outside.length === 0,
  "forty Tab presses never reach the page behind the drawer",
  JSON.stringify(outside),
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(
  !(await page.locator("#docs-drawer").evaluate((e) => e.matches(":popover-open"))),
  "Escape closes the drawer",
);
check((await opener.getAttribute("aria-expanded")) === "false", "the opener is collapsed again");
check(
  (await where(page)).startsWith("page:button.menu-btn"),
  "focus returns to the opener",
  await where(page),
);
const stillInert = await page.evaluate(() => document.querySelectorAll("[inert]").length);
check(stillInert === 0, "nothing stays inert after it closes", String(stillInert));
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
await page.mouse.click(380, 700);
await page.waitForTimeout(300);
check(
  !(await page.locator("#docs-drawer").evaluate((e) => e.matches(":popover-open"))),
  "a click outside the drawer closes it",
);
check(
  (await page.evaluate(() => document.querySelectorAll("[inert]").length)) === 0,
  "and nothing stays inert",
);
// Widening the window while the drawer is open closes it (it only exists below 960px) and frees the page.
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check(
  await page.locator("#docs-drawer").evaluate((e) => e.matches(":popover-open")),
  "it opens again",
);
await page.setViewportSize({ width: 1200, height: 800 });
await page.waitForTimeout(400);
check(
  !(await page.locator("#docs-drawer").evaluate((e) => e.matches(":popover-open"))),
  "widening the window closes it",
);
check(
  (await page.evaluate(() => document.querySelectorAll("[inert]").length)) === 0,
  "and the page is not left inert",
);
await browser.close();
server.stop();
console.log(failures === 0 ? "drawer: all checks passed" : `drawer: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
