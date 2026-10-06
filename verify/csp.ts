// The Content-Security-Policy of the pages, in a real browser, from both sides:
//
//   1. nothing the site does is blocked by it: on every page, searching, switching projects, the theme
//      toggle, the drawer and the code-copy buttons run without a single violation or script error;
//   2. what it exists for is blocked: markup injected into a built page (an event handler, a
//      javascript: link, an inline script, a script from another site, a frame, a form, a new <base>)
//      does nothing, whatever got past the lint and the output assertions.
//
//   bun csp.ts <dist>
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import { launch, routesOf, serve, snapshotOf, stubCatalog } from "./lib.ts";

const [distArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!distArg) {
  console.error("usage: bun csp.ts <dist>");
  process.exit(2);
}
const dist = resolve(distArg);
const snapshot = snapshotOf(dist);
let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && detail ? `  (${detail})` : ""}`);
};

const server = serve(dist);
const browser = await launch();
const origin = `http://localhost:${server.port}`;

/** Records every violation of the page's policy (the event of the platform) and every script error. */
async function record(page: Page): Promise<{ violations: () => Promise<string[]>; errors: string[] }> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) errors.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __violations?: string[] };
      (w.__violations ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return {
    errors,
    violations: () =>
      page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []),
  };
}

// 1. The site under its own policy.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await stubCatalog(context, snapshot);
  const page = await context.newPage();
  const seen = await record(page);
  const routes = routesOf(dist);
  let copyButtons = 0;
  let codeBlocks = 0;
  for (const route of routes) {
    await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
    codeBlocks += await page.locator("main pre > code").count();
    copyButtons += await page.locator("main pre > .copy-btn").count();
  }
  check(
    codeBlocks === copyButtons,
    "the scripts of every page ran: each code block has its copy button",
    `${codeBlocks} blocks, ${copyButtons} buttons`,
  );
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  const search = page.locator("docs-search button[data-variant]").first();
  await search.click();
  await page.waitForTimeout(500);
  await page.keyboard.type("install", { delay: 20 });
  await page
    .waitForSelector("#site-search-listbox [role=option]", { timeout: 5000 })
    .catch(() => {});
  const hits = await page.locator("#site-search-listbox [role=option]").count();
  check(hits > 0, "search finds pages (its index is fetched from the site itself)", `${hits}`);
  await page.keyboard.press("Escape");
  const before = await page.evaluate(() => document.documentElement.getAttribute("data-color-scheme"));
  await page.locator("theme-toggle button").first().click();
  const after = await page.evaluate(() => document.documentElement.getAttribute("data-color-scheme"));
  check(before !== after, "the theme toggle changes the scheme", `${before} -> ${after}`);
  await page.locator("project-switcher button.trigger").click();
  await page.waitForTimeout(500);
  check(
    (await page.locator("project-switcher .menu a").count()) > 2,
    "the project switcher lists the live catalog (a fetch to avunu.net is allowed)",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/docs/`, { waitUntil: "networkidle" });
  await page.locator(".menu-btn").click();
  await page.waitForTimeout(300);
  check(
    await page.locator("#docs-drawer").evaluate((e) => e.matches(":popover-open")),
    "the drawer opens",
  );
  const violations = await seen.violations();
  check(violations.length === 0, "no violation of the policy on the page being used", violations.join("; "));
  check(seen.errors.length === 0, "no script error, no policy message in the console", seen.errors.join("; "));
  await context.close();
}

// 2. What the policy exists for: the page is served with markup that a reader's browser must not run.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await stubCatalog(context, snapshot);
  const requested: string[] = [];
  await context.route("https://evil.invalid/**", (route) => {
    requested.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: "(window.__ran ??= []).push('external script')",
    });
  });
  const hostile = [
    `<img src="x" onerror="(window.__ran ??= []).push('onerror')">`,
    `<svg onload="(window.__ran ??= []).push('svg onload')"></svg>`,
    `<details open ontoggle="(window.__ran ??= []).push('ontoggle')"><summary>x</summary></details>`,
    `<a id="jslink" href="javascript:(window.__ran ??= []).push('javascript: link')">link</a>`,
    `<script>(window.__ran ??= []).push('inline script')</script>`,
    `<script src="https://evil.invalid/x.js"></script>`,
    `<iframe src="https://evil.invalid/frame.html"></iframe>`,
    `<form id="f" action="https://evil.invalid/post" method="post"><button id="send">send</button></form>`,
    `<base href="https://evil.invalid/">`,
  ].join("");
  await context.route(`${origin}/docs/**`, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      response,
      body: body.replace("</body>", `<main id="injected">${hostile}</main></body>`),
    });
  });
  const page = await context.newPage();
  const seen = await record(page);
  await page.goto(`${origin}/docs/`, { waitUntil: "networkidle" });
  await page.locator("#jslink").click({ noWaitAfter: true });
  await page.locator("#send").click({ force: true, noWaitAfter: true });
  await page.waitForTimeout(500);
  const ran = await page.evaluate(() => (window as unknown as { __ran?: string[] }).__ran ?? []);
  check(ran.length === 0, "nothing injected into the page ran", ran.join(", "));
  check(
    requested.length === 0,
    "no request went to the other site (script, frame, form post)",
    requested.join(", "),
  );
  check(
    (await page.evaluate(() => document.baseURI)) === `${origin}/docs/`,
    "an injected <base> does not move the page's addresses",
  );
  const violations = await seen.violations();
  for (const directive of ["script-src", "frame-src", "form-action", "base-uri"]) {
    check(
      violations.some((v) => v.startsWith(directive)),
      `the browser reported the ${directive} violation`,
      violations.join("; "),
    );
  }
  await context.close();
}

await browser.close();
server.stop();
console.log(failures === 0 ? "csp: all checks passed" : `csp: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
