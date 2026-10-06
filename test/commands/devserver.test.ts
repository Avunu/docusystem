import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { get, request, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  RELOAD_PATH,
  isIgnoredChange,
  locate,
  startDev,
  startServer,
  type DevHandle,
  type RebuildStatus,
  type StaticServer,
} from "../../src/lib/devserver.js";
import { tempDir, writeTree } from "../support/index.js";

const SITE: Record<string, string> = {
  "index.html": "<html><body><h1>Home</h1></body></html>",
  "docs/index.html": "<html><body><p>Docs home</p></body></html>",
  "docs/a/index.html": "<html><body><p>Page A</p></body></html>",
  "404.html": "<html><body><p>No such page</p></body></html>",
  "style.css": "body { color: black }",
  "fonts/f.woff2": "woff2-bytes",
  "data.bin": "bytes",
  "notes.txt": "plain",
  "search-index.json": "[]",
  "no-body.html": "<p>an html file without a body tag</p>",
  "two.html": "<html><body>one</body></html><!-- </body> --><body>two</body>",
  "folder-without-index/file.txt": "x",
};

// ---- locate ----

describe("locate (GitHub Pages semantics)", () => {
  let root = "";
  beforeEach(() => {
    root = writeTree(tempDir(), SITE);
  });

  test("files, folder indexes, and a redirect for a folder without its slash", () => {
    expect(locate(root, "/")).toEqual({ file: join(root, "index.html") });
    expect(locate(root, "/docs/")).toEqual({ file: join(root, "docs/index.html") });
    expect(locate(root, "/docs/a/")).toEqual({ file: join(root, "docs/a/index.html") });
    expect(locate(root, "/style.css")).toEqual({ file: join(root, "style.css") });
    expect(locate(root, "/docs/a")).toEqual({ redirect: "/docs/a/" });
    expect(locate(root, "/docs")).toEqual({ redirect: "/docs/" });
  });

  test("a missing path, a file with a trailing slash, and a folder without index.html are not found", () => {
    expect(locate(root, "/missing/")).toBeNull();
    expect(locate(root, "/missing")).toBeNull();
    expect(locate(root, "/style.css/")).toBeNull();
    expect(locate(root, "/folder-without-index/")).toBeNull();
  });

  test("percent-encoded names are decoded, and a bad encoding is not found", () => {
    writeTree(root, { "with space/index.html": "x" });
    expect(locate(root, "/with%20space/")).toEqual({ file: join(root, "with space/index.html") });
    expect(locate(root, "/%E0%A4%A")).toBeNull();
  });

  test("never leaves the folder it serves", () => {
    for (const path of [
      "/../etc/passwd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/docs/../../x",
      "/docs/%2e%2e/%2e%2e/x",
      "/..%2f..%2fetc/passwd",
      "/%00",
      "/docs/a/%00",
      "/..\\..\\etc\\passwd",
      "/docs%5c..%5c..%5cx",
    ]) {
      const hit = locate(root, path);
      expect(hit === null || ("file" in hit && hit.file.startsWith(root)), path).toBe(true);
    }
    expect(locate(root, "/../etc/passwd")).toBeNull();
    expect(locate(root, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(locate(root, "/%00")).toBeNull();
  });

  test("a redirect never starts with two slashes (that would leave this server)", () => {
    expect(locate(root, "//docs")).toEqual({ redirect: "/docs/" });
    expect(locate(root, "///docs/a")).toEqual({ redirect: "/docs/a/" });
  });
});

describe("isIgnoredChange", () => {
  const site = "/repo/docs-site";
  test("the build's own output and the tools' folders are ignored, wherever the watch started", () => {
    expect(isIgnoredChange(site, "/repo", "docs-site/dist/index.html")).toBe(true);
    expect(isIgnoredChange(site, "/repo", "docs-site/dist.tmp-123/index.html")).toBe(true);
    expect(isIgnoredChange(site, "/repo", "docs-site/dist.old-123")).toBe(true);
    expect(isIgnoredChange(site, "/repo", "docs-site/.docusystem/site/pages/x.json")).toBe(true);
    expect(isIgnoredChange(site, "/repo", ".git/index")).toBe(true);
    expect(isIgnoredChange(site, "/repo", "node_modules/a/b.js")).toBe(true);
    expect(isIgnoredChange(site, site, "dist")).toBe(true);
  });

  test("Markdown, overrides and public files are not", () => {
    expect(isIgnoredChange(site, "/repo/docs", "guide/x.md")).toBe(false);
    expect(isIgnoredChange(site, "/repo", "docs/guide/x.md")).toBe(false);
    expect(isIgnoredChange(site, `${site}/overrides`, "components/docs-footer.json")).toBe(false);
    expect(isIgnoredChange(site, `${site}/public`, "favicon.svg")).toBe(false);
    expect(isIgnoredChange(site, "/repo/docs", "distribution.md")).toBe(false);
  });

  test("editors' scratch files are ignored", () => {
    for (const name of ["x.md~", ".#x.md", "#x.md#", "x.md.swp", "x.md.swx", "4913", "x.md.tmp"]) {
      expect(isIgnoredChange(site, "/repo/docs", name), name).toBe(true);
    }
  });
});

// ---- the server ----

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

function fetchRaw(
  port: number,
  path: string,
  o: { method?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: o.method ?? "GET",
        headers: o.host === undefined ? {} : { host: o.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Opens the reload stream and collects what it sends. */
function openStream(port: number): Promise<{ events: string[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const events: string[] = [];
    const req = get({ host: "127.0.0.1", port, path: RELOAD_PATH }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => events.push(chunk));
      resolve({ events, close: () => req.destroy() });
    });
    req.on("error", reject);
  });
}

const SNIPPET = `<script>(()=>{const e=new EventSource("${RELOAD_PATH}");e.addEventListener("reload",()=>location.reload());})()</script>`;

const until = async (condition: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 10));
  }
};

describe("startServer", () => {
  let server: StaticServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const start = async (): Promise<number> => {
    server = await startServer({ root: writeTree(tempDir(), SITE), port: 0 });
    return server.port;
  };

  test("serves files with their types, and listens on loopback only", async () => {
    const port = await start();
    expect(port).toBeGreaterThan(0);
    const css = await fetchRaw(port, "/style.css");
    expect(css.status).toBe(200);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.headers["cache-control"]).toBe("no-store");
    expect(css.body).toBe("body { color: black }");
    expect((await fetchRaw(port, "/fonts/f.woff2")).headers["content-type"]).toBe("font/woff2");
    expect((await fetchRaw(port, "/search-index.json")).headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect((await fetchRaw(port, "/data.bin")).headers["content-type"]).toBe(
      "application/octet-stream",
    );
    // The socket is bound to 127.0.0.1, not to every interface.
    const address = (server as unknown as { port: number }).port;
    expect(address).toBe(port);
  });

  test("200 for a page, with the reload script before </body>", async () => {
    const port = await start();
    const page = await fetchRaw(port, "/docs/a/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.body).toBe(`<html><body><p>Page A</p>${SNIPPET}</body></html>`);
    expect(Number(page.headers["content-length"])).toBe(Buffer.byteLength(page.body));
  });

  test("the script goes before the last </body>, and at the end when there is none", async () => {
    const port = await start();
    expect((await fetchRaw(port, "/two.html")).body).toBe(
      `<html><body>one</body></html><!-- </body> --><body>two${SNIPPET}</body>`,
    );
    expect((await fetchRaw(port, "/no-body.html")).body).toBe(
      `<p>an html file without a body tag</p>${SNIPPET}`,
    );
  });

  test("non-HTML files are not touched", async () => {
    const port = await start();
    expect((await fetchRaw(port, "/notes.txt")).body).toBe("plain");
    expect((await fetchRaw(port, "/data.bin")).body).toBe("bytes");
  });

  test("301 for a folder without its slash, keeping the query", async () => {
    const port = await start();
    const redirect = await fetchRaw(port, "/docs/a?x=1&y=2");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.location).toBe("/docs/a/?x=1&y=2");
    const double = await fetchRaw(port, "//docs");
    expect(double.status).toBe(301);
    expect(double.headers.location).toBe("/docs/");
  });

  test("404 with 404.html for what is missing, and for a bad path", async () => {
    const port = await start();
    for (const path of [
      "/missing/",
      "/missing",
      "/style.css/",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/%00",
    ]) {
      const reply = await fetchRaw(port, path);
      expect(reply.status, path).toBe(404);
      expect(reply.body, path).toContain("No such page");
      expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    }
  });

  test("404 as plain text when the build has no 404.html", async () => {
    const root = writeTree(tempDir(), { "index.html": "<body></body>" });
    server = await startServer({ root, port: 0 });
    const reply = await fetchRaw(server.port, "/nope/");
    expect(reply.status).toBe(404);
    expect(reply.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  test("HEAD answers headers only; other methods are refused", async () => {
    const port = await start();
    const head = await fetchRaw(port, "/style.css", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(Number(head.headers["content-length"])).toBe("body { color: black }".length);
    const post = await fetchRaw(port, "/", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
  });

  test("answers only requests whose Host is this machine (DNS rebinding)", async () => {
    const port = await start();
    expect((await fetchRaw(port, "/", { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await fetchRaw(port, "/", { host: `localhost:${port}` })).status).toBe(200);
    expect((await fetchRaw(port, "/", { host: "LOCALHOST" })).status).toBe(200);
    expect((await fetchRaw(port, "/", { host: `[::1]:${port}` })).status).toBe(200);
    for (const host of [
      "evil.example",
      `evil.example:${port}`,
      "127.0.0.1.evil.example",
      "localhost.evil.example:80",
    ]) {
      expect((await fetchRaw(port, "/", { host })).status, host).toBe(403);
    }
  });

  test("the reload stream sends an event when told to, to every open page", async () => {
    const port = await start();
    const one = await openStream(port);
    const two = await openStream(port);
    await until(() => one.events.length > 0 && two.events.length > 0);
    expect(one.events[0]).toBe("retry: 500\n\n");
    server?.reload();
    await until(() => one.events.length > 1 && two.events.length > 1);
    expect(one.events[1]).toBe("event: reload\ndata: now\n\n");
    one.close();
    two.close();
  });

  test("a port that is taken rejects with EADDRINUSE", async () => {
    const port = await start();
    await expect(startServer({ root: tempDir(), port })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  test("close ends the open streams and stops listening", async () => {
    const port = await start();
    const stream = await openStream(port);
    await until(() => stream.events.length > 0);
    await server?.close();
    server = undefined;
    await expect(fetchRaw(port, "/")).rejects.toThrow();
  });
});

// ---- the loop ----

describe("startDev", () => {
  let dev: DevHandle | undefined;
  afterEach(async () => {
    await dev?.close();
    dev = undefined;
  });

  /** A shell whose "build" copies docs/*.md to dist as pages, and fails while a file says BROKEN. */
  function shell() {
    const dir = tempDir();
    const siteDir = join(dir, "docs-site");
    const docsDir = join(dir, "docs");
    const paths = {
      siteDir,
      docsDir,
      dist: join(siteDir, "dist"),
      serve: join(siteDir, ".docusystem", "serve"),
    };
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(docsDir, "a.md"), "first");
    const log: string[] = [];
    const errors: string[] = [];
    const builds = {
      count: 0,
      status: "ok" as RebuildStatus,
      delay: 0,
      queue: [] as RebuildStatus[],
    };
    const rebuild = async (): Promise<RebuildStatus> => {
      builds.count++;
      if (builds.delay > 0) await new Promise((done) => setTimeout(done, builds.delay));
      const status = builds.queue.shift() ?? builds.status;
      const text = readFileSync(join(docsDir, "a.md"), "utf8");
      if (status === "ok" && text.includes("BROKEN")) return "failed";
      if (status === "ok") {
        rmSync(paths.dist, { recursive: true, force: true });
        mkdirSync(paths.dist, { recursive: true });
        writeFileSync(join(paths.dist, "index.html"), `<html><body>${text}</body></html>`);
      }
      return status;
    };
    return { dir, paths, docsDir, siteDir, log, errors, builds, rebuild };
  }

  const begin = async (
    s: ReturnType<typeof shell>,
    extra: {
      retryMs?: number;
      wrap?: (inner: () => Promise<RebuildStatus>) => () => Promise<RebuildStatus>;
    } = {},
  ) => {
    await s.rebuild(); // the first build, as the command does
    s.builds.count = 0;
    dev = await startDev({
      paths: s.paths,
      port: 0,
      rebuild: extra.wrap === undefined ? s.rebuild : extra.wrap(s.rebuild),
      log: (line) => s.log.push(line),
      error: (line) => s.errors.push(line),
      debounceMs: 20,
      ...(extra.retryMs === undefined ? {} : { retryMs: extra.retryMs }),
    });
    return dev;
  };

  test("serves the first build from <work>/serve, on 127.0.0.1", async () => {
    const s = shell();
    const handle = await begin(s);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/`);
    const page = await fetchRaw(handle.port, "/");
    expect(page.body).toContain("first");
    expect(readFileSync(join(s.paths.serve, "index.html"), "utf8")).toContain("first");
  });

  test("a change to the Markdown rebuilds, swaps the new site in and tells the pages to reload", async () => {
    const s = shell();
    const handle = await begin(s);
    const stream = await openStream(handle.port);
    await until(() => stream.events.length > 0);
    writeFileSync(join(s.docsDir, "a.md"), "second");
    await until(() => stream.events.some((chunk) => chunk.includes("event: reload")));
    await handle.idle();
    expect((await fetchRaw(handle.port, "/")).body).toContain("second");
    expect(s.builds.count).toBe(1);
    stream.close();
  });

  test("a failed rebuild keeps serving the last good build and sends no reload; the next good one recovers", async () => {
    const s = shell();
    const handle = await begin(s);
    const stream = await openStream(handle.port);
    await until(() => stream.events.length > 0);

    writeFileSync(join(s.docsDir, "a.md"), "BROKEN");
    await until(() => s.builds.count >= 1);
    await handle.idle();
    expect((await fetchRaw(handle.port, "/")).body).toContain("first");
    expect(stream.events.some((chunk) => chunk.includes("event: reload"))).toBe(false);

    writeFileSync(join(s.docsDir, "a.md"), "fixed");
    await until(() => stream.events.some((chunk) => chunk.includes("event: reload")));
    await handle.idle();
    expect((await fetchRaw(handle.port, "/")).body).toContain("fixed");
    stream.close();
  });

  test("a rebuild that throws is reported and the server keeps serving", async () => {
    const s = shell();
    let first = true;
    const handle = await begin(s, {
      wrap: (inner) => async () => {
        if (first) {
          first = false;
          throw new Error("the build exploded");
        }
        return inner();
      },
    });
    handle.trigger();
    await handle.idle();
    expect(s.errors).toContain("dev: the build exploded");
    expect((await fetchRaw(handle.port, "/")).body).toContain("first");
    writeFileSync(join(s.docsDir, "a.md"), "after");
    await until(() => s.builds.count >= 1);
    await handle.idle();
    expect((await fetchRaw(handle.port, "/")).body).toContain("after");
  });

  test("changes during a build cause exactly one more build, and builds never overlap", async () => {
    const s = shell();
    let running = 0;
    let overlapped = false;
    const handle = await begin(s, {
      wrap: (inner) => async () => {
        running++;
        if (running > 1) overlapped = true;
        try {
          return await inner();
        } finally {
          running--;
        }
      },
    });
    s.builds.delay = 150;
    writeFileSync(join(s.docsDir, "a.md"), "one");
    await until(() => s.builds.count >= 1);
    for (const text of ["two", "three", "four"]) {
      writeFileSync(join(s.docsDir, "a.md"), text);
      await new Promise((done) => setTimeout(done, 30));
    }
    await handle.idle();
    expect(s.builds.count).toBe(2);
    expect(overlapped).toBe(false);
    expect((await fetchRaw(handle.port, "/")).body).toContain("four");
  });

  test("a build that finds the lock taken is tried again after retryMs", async () => {
    const s = shell();
    const handle = await begin(s, { retryMs: 40 });
    s.builds.queue.push("busy", "busy", "ok");
    writeFileSync(join(s.docsDir, "a.md"), "later");
    await until(() => s.builds.count >= 3);
    await handle.idle();
    expect(s.builds.count).toBe(3);
    expect((await fetchRaw(handle.port, "/")).body).toContain("later");
  });

  test("the build's own output does not cause a build, and nor does a scratch file", async () => {
    const s = shell();
    const handle = await begin(s);
    writeFileSync(join(s.docsDir, "a.md~"), "scratch");
    writeFileSync(join(s.docsDir, ".#a.md"), "scratch");
    mkdirSync(join(s.siteDir, ".docusystem"), { recursive: true });
    writeFileSync(join(s.siteDir, ".docusystem", "jx.log"), "log");
    await new Promise((done) => setTimeout(done, 250));
    await handle.idle();
    expect(s.builds.count).toBe(0);
  });

  test("overrides/ and public/ created after the start are noticed", async () => {
    const s = shell();
    const handle = await begin(s);
    mkdirSync(join(s.siteDir, "overrides", "components"), { recursive: true });
    await until(() => s.builds.count >= 1);
    await handle.idle();
    const before = s.builds.count;
    writeFileSync(join(s.siteDir, "overrides", "components", "docs-footer.json"), "{}");
    await until(() => s.builds.count > before);
    await handle.idle();
    expect(s.builds.count).toBeGreaterThan(before);
  });

  test("a change to docusystem.config.json rebuilds, even when an editor replaces the file", async () => {
    const s = shell();
    writeFileSync(join(s.siteDir, "docusystem.config.json"), "{}");
    const handle = await begin(s);
    writeFileSync(join(s.siteDir, "docusystem.config.json.new"), '{"name": "x"}');
    renameSync(
      join(s.siteDir, "docusystem.config.json.new"),
      join(s.siteDir, "docusystem.config.json"),
    );
    await until(() => s.builds.count >= 1);
    await handle.idle();
    expect(s.builds.count).toBeGreaterThanOrEqual(1);
  });

  test("close stops the server and the watchers; a pending rebuild does not run", async () => {
    const s = shell();
    const handle = await begin(s);
    handle.trigger();
    await handle.close();
    dev = undefined;
    await new Promise((done) => setTimeout(done, 100));
    expect(s.builds.count).toBe(0);
    await expect(fetchRaw(handle.port, "/")).rejects.toThrow();
  });

  test("a port that is taken rejects before anything is watched", async () => {
    const s = shell();
    const taken = await startServer({ root: tempDir(), port: 0 });
    try {
      await s.rebuild();
      await expect(
        startDev({
          paths: s.paths,
          port: taken.port,
          rebuild: s.rebuild,
          log: () => {},
          error: () => {},
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await taken.close();
    }
  });
});
