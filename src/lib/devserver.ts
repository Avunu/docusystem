// The server of `docusystem dev` (section 5.2 of the architecture decision record): it serves a copy of
// `<site>/dist` the way GitHub Pages will serve it, watches what the site is made of, rebuilds when it
// changes and tells the open pages to reload.
//
// It is deliberately not `jx dev`: that brings Bun, a Studio and about 80 MB of packages for a site that
// is plain static output, and it sees only files inside the project root while the Markdown is outside
// it. Serving the finished build shows what CI publishes (trailing slashes, 404.html, the post-build
// fixes), and a rebuild takes about a second.
//
//   - GitHub Pages semantics: a folder without its trailing slash answers 301, a missing path answers
//     404 with 404.html, a path never leaves the served folder.
//   - Served from `<work>/serve`, a copy that is swapped in whole (`replaceDir`) after each successful
//     build, so a request never sees a half-written site, and a failed build keeps the last good one.
//   - Binds to 127.0.0.1 only, and answers only requests whose Host is loopback (a web page on another
//     origin cannot reach it through DNS rebinding).
//   - `/__reload` is a server-sent-events stream; every HTML page gets a script (`/__reload.js`) that
//     listens to it and reloads, injected before `</body>` as the page is sent.
//   - `fs.watch` on the Markdown folder, `overrides/`, `public/` and the site folder (for the
//     configuration, and for `overrides/` and `public/` appearing); changes are debounced; one rebuild
//     runs at a time, and a change that arrives during a build causes exactly one more.
import { type FSWatcher, existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { CONFIG_FILE } from "./config.js";
import { isInside, replaceDir } from "./fsutil.js";
import type { Paths } from "./types.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export const RELOAD_PATH = "/__reload";
/**
 * The reload script is a file the server answers, not an inline script: the pages carry a
 * Content-Security-Policy that refuses inline scripts the build did not write (csp.ts).
 */
export const RELOAD_SCRIPT_PATH = "/__reload.js";
const RELOAD_SCRIPT = `(()=>{const e=new EventSource("${RELOAD_PATH}");e.addEventListener("reload",()=>location.reload());})()`;
const RELOAD_SNIPPET = `<script src="${RELOAD_SCRIPT_PATH}"></script>`;

/** A Host header that is this machine: `127.0.0.1`, `localhost` or `[::1]`, with or without a port. */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/**
 * Where a request path lands in `root`, GitHub Pages style: a file (a path with a trailing slash is not
 * one), a folder's `index.html`, a redirect to the folder's address with the slash, or null (404). The
 * path is percent-decoded, and null when it holds a NUL or a backslash or leads outside `root`.
 * `pathname` has no query string.
 */
export function locate(
  root: string,
  pathname: string,
): { file: string } | { redirect: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const base = resolve(root);
  const target = resolve(base, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (!isInside(base, target)) return null;
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return null;
  }
  if (stat.isFile()) return pathname.endsWith("/") ? null : { file: target };
  if (!stat.isDirectory()) return null;
  if (!pathname.endsWith("/")) {
    // One leading slash: `//host/x` as a Location would leave this server.
    return { redirect: `/${pathname.replace(/^\/+/, "")}/` };
  }
  const index = join(target, "index.html");
  return existsSync(index) ? { file: index } : null;
}

/** `html` with the reload script just before the last `</body>` (at the end when there is none). */
function withReload(html: string): string {
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at < 0 ? html + RELOAD_SNIPPET : html.slice(0, at) + RELOAD_SNIPPET + html.slice(at);
}

export interface StaticServer {
  /** The port it listens on (the real one when 0 was asked for). */
  port: number;
  /** Tells every open page to reload. */
  reload(): void;
  close(): Promise<void>;
}

/** Starts the server on 127.0.0.1; rejects (`EADDRINUSE`, ...) when it cannot listen. */
export function startServer(o: { root: string; port: number }): Promise<StaticServer> {
  const clients = new Set<ServerResponse>();

  const send = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    type: string,
    body: Buffer | string,
  ): void => {
    const bytes = typeof body === "string" ? Buffer.from(body) : body;
    res.writeHead(status, {
      "content-type": type,
      "content-length": bytes.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  };

  const sendFile = (req: IncomingMessage, res: ServerResponse, file: string, status: number) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      send(req, res, 404, "text/plain; charset=utf-8", "Not found");
      return;
    }
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    send(
      req,
      res,
      status,
      type,
      type.startsWith("text/html") ? withReload(bytes.toString("utf8")) : bytes,
    );
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const host = req.headers.host;
    if (host !== undefined && !LOOPBACK_HOST.test(host)) {
      send(req, res, 403, "text/plain; charset=utf-8", "docusystem dev answers only on 127.0.0.1");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return;
    }
    const raw = req.url ?? "/";
    if (!raw.startsWith("/")) {
      send(req, res, 400, "text/plain; charset=utf-8", "Bad request");
      return;
    }
    const question = raw.indexOf("?");
    const pathname = question < 0 ? raw : raw.slice(0, question);
    const search = question < 0 ? "" : raw.slice(question);

    if (pathname === RELOAD_PATH) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("retry: 500\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (pathname === RELOAD_SCRIPT_PATH) {
      send(req, res, 200, "text/javascript; charset=utf-8", RELOAD_SCRIPT);
      return;
    }

    const hit = locate(o.root, pathname);
    if (hit !== null && "redirect" in hit) {
      res.writeHead(301, { location: hit.redirect + search, "cache-control": "no-store" });
      res.end();
      return;
    }
    if (hit !== null) {
      sendFile(req, res, hit.file, 200);
      return;
    }
    const notFound = join(o.root, "404.html");
    if (existsSync(notFound)) sendFile(req, res, notFound, 404);
    else send(req, res, 404, "text/plain; charset=utf-8", "Not found");
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`docusystem dev: ${(error as Error).message}`);
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise({
        port: (server.address() as AddressInfo).port,
        reload: () => {
          for (const client of clients) client.write("event: reload\ndata: now\n\n");
        },
        close: () =>
          new Promise<void>((done) => {
            for (const client of clients) client.end();
            clients.clear();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

// ---- watching ----

/** Folders whose changes are never the Markdown or the site: tools' and the build's own. */
const NEVER_WATCHED = new Set([".git", "node_modules", ".docusystem"]);

/** Editors' scratch files: `x.md~`, `.#x.md`, `x.md.swp`, `#x.md#`, `4913`. */
const SCRATCH = /(?:~|\.sw[a-z]|\.tmp)$|^(?:\.#|#)|^4913$/;

/**
 * Whether a change is the build's own output or an editor's scratch file, so that it does not cause a
 * rebuild: `name` (the path `fs.watch` reports, relative to the watched folder `watched`) has a
 * `.git`, `node_modules` or `.docusystem` folder in it, or lies inside the site's `dist` (or the
 * `dist.tmp-*` and `dist.old-*` of a swap), or is a scratch file. Without this a Markdown folder that
 * contains the site folder would rebuild on its own output for ever.
 */
export function isIgnoredChange(siteDir: string, watched: string, name: string): boolean {
  const parts = name.split(sep);
  if (parts.some((part) => NEVER_WATCHED.has(part))) return true;
  const first = relative(siteDir, join(watched, name)).split(sep)[0] ?? "";
  if (first === "dist" || first.startsWith("dist.tmp-") || first.startsWith("dist.old-")) {
    return true;
  }
  return SCRATCH.test(parts.at(-1) ?? "");
}

export interface Watching {
  /** Starts watching what exists now and was not watched yet (`overrides/` created after the start). */
  refresh(): void;
  close(): void;
}

/**
 * Watches the Markdown folder, `<site>/overrides` and `<site>/public` (recursively) and the site folder
 * itself (for the configuration file, and for `overrides` and `public` appearing). `onChange` gets the
 * path that changed.
 */
export function watchSources(o: {
  siteDir: string;
  docsDir: string;
  onChange: (path: string) => void;
  error: (line: string) => void;
}): Watching {
  const watchers = new Map<string, FSWatcher>();
  const siteNames = new Set([CONFIG_FILE, "overrides", "public"]);

  const add = (dir: string, recursive: boolean): void => {
    if (watchers.has(dir) || !existsSync(dir)) return;
    try {
      const watcher = watch(dir, { recursive }, (_event, filename) => {
        const name = filename === null ? "" : String(filename);
        if (recursive) {
          if (name !== "" && isIgnoredChange(o.siteDir, dir, name)) return;
        } else {
          if (!siteNames.has(name)) return;
          refresh();
        }
        o.onChange(join(dir, name));
      });
      watcher.on("error", (error) => {
        o.error(`dev: watching ${dir} stopped: ${error.message}`);
        watchers.delete(dir);
        watcher.close();
      });
      watchers.set(dir, watcher);
    } catch (error) {
      o.error(
        `dev: cannot watch ${dir}: ${(error as Error).message}; changes there are not noticed`,
      );
    }
  };
  const refresh = (): void => {
    add(o.siteDir, false);
    add(o.docsDir, true);
    add(join(o.siteDir, "overrides"), true);
    add(join(o.siteDir, "public"), true);
  };
  refresh();
  return {
    refresh,
    close: () => {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

// ---- the loop ----

/** What one rebuild came to: published, failed (the last good site is still served), or the lock was taken. */
export type RebuildStatus = "ok" | "failed" | "busy";

export interface DevOptions {
  paths: Pick<Paths, "siteDir" | "docsDir" | "dist" | "serve">;
  port: number;
  /** One build; on "ok" `paths.dist` holds the new site. */
  rebuild: () => Promise<RebuildStatus>;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Default 150. */
  debounceMs?: number;
  /** How long to wait before trying again when another docusystem process held the lock. Default 1000. */
  retryMs?: number;
}

export interface DevHandle {
  port: number;
  url: string;
  /** Schedules a rebuild as if a file had changed. */
  trigger(): void;
  /** Resolves when no rebuild is scheduled or running (the reload, if any, has been sent). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Serves `paths.dist` (already built) and keeps it fresh: copies it to `paths.serve`, listens on
 * 127.0.0.1:`port` (rejects when that fails), and rebuilds on every change.
 */
export async function startDev(o: DevOptions): Promise<DevHandle> {
  replaceDir(o.paths.dist, o.paths.serve);
  const server = await startServer({ root: o.paths.serve, port: o.port });
  const debounceMs = o.debounceMs ?? 150;
  const retryMs = o.retryMs ?? 1000;

  const state: {
    timer: ReturnType<typeof setTimeout> | undefined;
    building: boolean;
    again: boolean;
    closed: boolean;
  } = { timer: undefined, building: false, again: false, closed: false };

  const schedule = (ms: number): void => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void build();
    }, ms);
  };

  async function build(): Promise<void> {
    if (state.building) {
      state.again = true;
      return;
    }
    state.building = true;
    try {
      do {
        state.again = false;
        let status: RebuildStatus;
        try {
          // One rebuild at a time is the point: the loop is deliberately sequential.
          // oxlint-disable-next-line no-await-in-loop
          status = await o.rebuild();
        } catch (error) {
          o.error(`dev: ${(error as Error).message}`);
          status = "failed";
        }
        if (state.closed) break;
        if (status === "ok") {
          try {
            replaceDir(o.paths.dist, o.paths.serve);
            server.reload();
          } catch (error) {
            o.error(`dev: cannot serve the new build: ${(error as Error).message}`);
          }
        } else if (status === "busy") {
          schedule(retryMs);
        }
      } while (state.again && !state.closed);
    } finally {
      state.building = false;
    }
  }

  const watching = watchSources({
    siteDir: o.paths.siteDir,
    docsDir: o.paths.docsDir,
    onChange: () => schedule(debounceMs),
    error: o.error,
  });

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}/`,
    trigger: () => schedule(0),
    idle: async () => {
      while (state.building || state.timer !== undefined) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((done) => setTimeout(done, 5));
      }
    },
    close: async () => {
      state.closed = true;
      clearTimeout(state.timer);
      state.timer = undefined;
      watching.close();
      await server.close();
    },
  };
}
