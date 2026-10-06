// Shared helpers for the browser suites: a static server for a built site, a Chrome launcher, and the
// stub for https://avunu.net/projects.json so that a run never depends on the network.
//
// Every suite takes the Jx output of a built site, `<site>/.docusystem/site/dist`. Its parent is the
// assembled Jx project root, which holds what the suites read next to it: `docusystem.config.json` (the
// resolved configuration) and `data/projects.snapshot.json` (the bundled project catalog).
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".md": "text/markdown",
};

/** Serves a built site the way GitHub Pages does: directories get index.html, unknown paths get 404.html with a 404 status. */
export function serve(dist: string) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const file = normalize(join(dist, path));
      if (file !== dist && !file.startsWith(`${dist}${sep}`)) {
        return new Response("forbidden", { status: 403 });
      }
      let target = file;
      if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
      if (!existsSync(target)) {
        const notFound = join(dist, "404.html");
        return new Response(existsSync(notFound) ? Bun.file(notFound) : "not found", {
          status: 404,
          headers: { "content-type": TYPES[".html"]! },
        });
      }
      return new Response(Bun.file(target), {
        headers: { "content-type": TYPES[extname(target)] ?? "application/octet-stream" },
      });
    },
  });
}

export function chromeBin(): string {
  const candidates = [
    process.env.CHROME_BIN,
    "/run/current-system/sw/bin/google-chrome-stable",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean) as string[];
  const found =
    candidates.find((c) => existsSync(c)) ??
    Bun.which("google-chrome-stable") ??
    Bun.which("chromium") ??
    Bun.which("google-chrome");
  if (!found) throw new Error("No Chrome or Chromium found. Install one or set CHROME_BIN.");
  return found;
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: chromeBin(), args: ["--no-sandbox"] });
}

/** The resolved configuration of the site (`docusystem.config.json` of the assembled root). */
export function configOf(dist: string): {
  name: string;
  slug: string;
  domain: string;
  docs?: string;
} {
  return JSON.parse(readFileSync(join(dist, "..", "docusystem.config.json"), "utf8"));
}

/** The text of the bundled project catalog the site was built with. */
export function snapshotOf(dist: string): string {
  return readFileSync(join(dist, "..", "data", "projects.snapshot.json"), "utf8");
}

/**
 * Makes https://avunu.net/projects.json answer with `body` (with the CORS header the real one sends), or
 * fail when `body` is null; and answers every image of another site with a small placeholder (a page may
 * show an image of its repository from GitHub, which a sample repository does not have), so that a run
 * never depends on the network.
 */
export async function stubCatalog(context: BrowserContext, body: string | null): Promise<void> {
  await context.route("https://avunu.net/projects.json", (route) => {
    if (body === null) return route.abort("failed");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body,
    });
  });
  await context.route(
    (url) => url.protocol === "https:" && url.pathname !== "/projects.json",
    (route) => {
      if (route.request().resourceType() !== "image") return route.abort("failed");
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#888"/></svg>',
      });
    },
  );
}

export interface Probe {
  consoleErrors: string[];
  failedRequests: string[];
}

/** Collects console errors and failed requests on a page. */
export function watch(page: Page): Probe {
  const probe: Probe = { consoleErrors: [], failedRequests: [] };
  page.on("console", (m) => {
    if (m.type() === "error") probe.consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => probe.consoleErrors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) =>
    probe.failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`),
  );
  return probe;
}

export const WIDTHS = [1440, 768, 390] as const;
export const SCHEMES = ["light", "dark"] as const;

/** The pages of a built site, from its sitemap plus the home and 404 pages. */
export function routesOf(dist: string): string[] {
  const routes = new Set<string>(["/", "/404.html"]);
  const sitemap = join(dist, "sitemap.xml");
  if (existsSync(sitemap)) {
    for (const m of readFileSync(sitemap, "utf8").matchAll(/<loc>([^<]+)<\/loc>/g))
      routes.add(new URL(m[1]!).pathname);
  }
  return [...routes].sort();
}

/**
 * A documentation page for the suites that open overlays and need something to show: the page below a
 * section with the most headings (so that the contents list has entries), else the first.
 */
export function defaultDocsRoute(dist: string): string {
  const docs = routesOf(dist).filter((r) => r.startsWith("/docs/") && r !== "/docs/");
  const headings = (route: string) => {
    const file = join(dist, route, "index.html");
    return existsSync(file) ? (readFileSync(file, "utf8").match(/<h2[\s>]/g) ?? []).length : 0;
  };
  return docs.reduce(
    (best, route) => (headings(route) > headings(best) ? route : best),
    docs[0] ?? "/docs/",
  );
}

export function slugOf(route: string): string {
  return route === "/" ? "home" : route.replace(/^\/|\/$/g, "").replaceAll("/", "_");
}
