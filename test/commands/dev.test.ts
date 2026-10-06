import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LockError } from "../../src/lib/lock.js";
import type { PipelineDeps } from "../../src/lib/pipeline.js";
import { run } from "../../src/main.js";
import { makeWorld, type World } from "./support/world.js";

const holder = vi.hoisted(() => ({ deps: undefined as undefined | PipelineDeps }));
vi.mock("../../src/lib/pipeline.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/pipeline.js")>();
  return {
    ...real,
    defaultDeps: () => holder.deps!,
    runPipeline: (o: Parameters<typeof real.runPipeline>[0]) =>
      real.runPipelineWith(o, holder.deps!),
  };
});

const until = async (condition: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 10));
  }
};

interface Reply {
  status: number;
  location?: string;
  body: string;
}

const fetchPage = (port: number, path: string): Promise<Reply> =>
  new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    })
      .on("error", reject)
      .end();
  });

/** `docusystem dev` running in this process, with a controller to stop it. */
function start(world: World, argv: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const controller = new AbortController();
  const done = run(["dev", "--port", "0", ...argv], {
    cwd: world.dir,
    env,
    color: false,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    signal: controller.signal,
  });
  const port = async (): Promise<number> => {
    await until(() => out.some((line) => line.startsWith("dev: http://")) || err.length > 0);
    const line = out.find((l) => l.startsWith("dev: http://"));
    if (line === undefined) throw new Error(`dev did not start: ${err.join("\n")}`);
    return Number(/:(\d+)\//.exec(line)?.[1]);
  };
  return { out, err, controller, done, port };
}

let world: World;
let running: ReturnType<typeof start> | undefined;
beforeEach(() => {
  world = makeWorld();
  holder.deps = world.deps;
  writeFileSync(join(world.paths.docsDir, "a.md"), "first");
  // The site is the Markdown: the fake Jx writes the text of docs/a.md as the home page, and a text
  // with BROKEN in it makes the build fail (the way a document that Jx cannot compile does).
  const inner = world.deps.runJx;
  world.deps.runJx = async (command, o) => {
    const text = readFileSync(join(world.paths.docsDir, "a.md"), "utf8");
    world.jx.code = text.includes("BROKEN") ? 1 : 0;
    world.jx.output = text.includes("BROKEN")
      ? "Error compiling /: the document is broken\n"
      : undefined;
    const result = await inner(command, o);
    if (result.code === 0) {
      writeFileSync(join(world.paths.jxDist, "index.html"), `<html><body>${text}</body></html>\n`);
    }
    return result;
  };
});
afterEach(async () => {
  if (running !== undefined) {
    running.controller.abort();
    await running.done;
    running = undefined;
  }
});

describe("docusystem dev", () => {
  test("builds once, serves the result on 127.0.0.1 and exits 0 when stopped", async () => {
    running = start(world);
    const port = await running.port();
    expect(running.out).toContain(
      `dev: http://127.0.0.1:${port}/  (watching ${world.paths.docsDir}, overrides/, public/ and docusystem.config.json; Ctrl-C stops)`,
    );
    expect(running.out.some((line) => /^dev: built in \d+ ms$/.test(line))).toBe(true);
    const home = await fetchPage(port, "/");
    expect(home.status).toBe(200);
    expect(home.body).toContain("first");
    expect(readFileSync(join(world.paths.serve, "index.html"), "utf8")).toContain("first");
    running.controller.abort();
    expect(await running.done).toBe(0);
    running = undefined;
    await expect(fetchPage(port, "/")).rejects.toThrow();
  });

  test("serves 200, 301 and 404 as GitHub Pages does", async () => {
    running = start(world);
    const port = await running.port();
    expect((await fetchPage(port, "/")).status).toBe(200);
    expect((await fetchPage(port, "/docs/")).status).toBe(200);
    const redirect = await fetchPage(port, "/docs");
    expect(redirect.status).toBe(301);
    expect(redirect.location).toBe("/docs/");
    const missing = await fetchPage(port, "/nope/");
    expect(missing.status).toBe(404);
    expect(missing.body).toContain("not found");
    expect((await fetchPage(port, "/..%2f..%2fetc/passwd")).status).toBe(404);
  });

  test("an edit rebuilds and reloads the open pages", async () => {
    running = start(world);
    const port = await running.port();
    const events: string[] = [];
    const stream = get({ host: "127.0.0.1", port, path: "/__reload" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => events.push(chunk));
    });
    await until(() => events.length > 0);
    writeFileSync(join(world.paths.docsDir, "a.md"), "second");
    await until(() => events.some((chunk) => chunk.includes("event: reload")));
    expect((await fetchPage(port, "/")).body).toContain("second");
    expect(running.out.some((line) => /^dev: rebuilt in \d+ ms$/.test(line))).toBe(true);
    stream.destroy();
  });

  test("survives a broken edit: the problems are printed, the last good build is served, no reload", async () => {
    running = start(world);
    const port = await running.port();
    const events: string[] = [];
    const stream = get({ host: "127.0.0.1", port, path: "/__reload" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => events.push(chunk));
    });
    await until(() => events.length > 0);

    writeFileSync(join(world.paths.docsDir, "a.md"), "BROKEN");
    await until(() => running!.out.some((line) => line.startsWith("dev: the build failed")));
    expect(running.err).toContain(
      `docusystem: jx build failed. The assembled project is ${world.paths.root}; run: ${process.execPath} /fake/jx/bin/jx.js build ${world.paths.root}`,
    );
    expect((await fetchPage(port, "/")).body).toContain("first");
    expect(events.some((chunk) => chunk.includes("event: reload"))).toBe(false);

    writeFileSync(join(world.paths.docsDir, "a.md"), "repaired");
    await until(() => events.some((chunk) => chunk.includes("event: reload")));
    expect((await fetchPage(port, "/")).body).toContain("repaired");
    stream.destroy();
  });

  test("is always lenient, even with CI=true: lint errors do not stop it", async () => {
    world.lint = [
      {
        file: "a.md",
        line: 1,
        level: "error",
        rule: "footnote",
        message: "Footnotes are not rendered.",
      },
    ];
    running = start(world, [], { CI: "true" });
    await running.port();
    expect(world.seen.assemble[0]?.strict).toBe(false);
    expect(running.err).toContain("lint: warning: docs/a.md:1  Footnotes are not rendered.");
  });

  test("a first build that fails is exit 1 and nothing is served", async () => {
    writeFileSync(join(world.paths.docsDir, "a.md"), "BROKEN");
    running = start(world);
    expect(await running.done).toBe(1);
    expect(running.err.at(-1)).toBe(
      "dev: the first build failed: fix the problems above and run docusystem dev again",
    );
    expect(running.out.some((line) => line.startsWith("dev: http://"))).toBe(false);
    running = undefined;
  });

  test("a first build that finds the lock taken is exit 3, naming the pid", async () => {
    world.lockError = new LockError(777);
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["dev", "--port", "0"], {
      cwd: world.dir,
      env: {},
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(3);
    expect(err).toEqual(["docusystem: another docusystem process (pid 777) is running"]);
  });

  test("a port that is taken is exit 1 and says so", async () => {
    running = start(world);
    const port = await running.port();
    const second = makeWorld();
    holder.deps = second.deps;
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["dev", "--port", String(port)], {
      cwd: second.dir,
      env: {},
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    holder.deps = world.deps;
    expect(code).toBe(1);
    expect(err.at(-1)).toBe(
      `dev: cannot listen on 127.0.0.1:${port} (already in use): stop what is using it, or pass --port <n>`,
    );
  });

  test("a rebuild that finds the lock taken waits and tries again", async () => {
    running = start(world);
    const port = await running.port();
    // The next acquisition fails once with a LockError, then works.
    const acquire = world.deps.acquireLock;
    let refused = false;
    world.deps.acquireLock = (paths, o) => {
      if (!refused) {
        refused = true;
        throw new LockError(5150);
      }
      return acquire(paths, o);
    };
    writeFileSync(join(world.paths.docsDir, "a.md"), "after the lock");
    await until(() =>
      running!.err.some((line) => line.includes("another docusystem process (pid 5150)")),
    );
    await until(() => running!.out.some((line) => line.startsWith("dev: rebuilt")), 10000);
    expect((await fetchPage(port, "/")).body).toContain("after the lock");
  });

  test("a stop request before the server is up is honoured", async () => {
    mkdirSync(world.paths.docsDir, { recursive: true });
    const controller = new AbortController();
    controller.abort();
    const out: string[] = [];
    const code = await run(["dev", "--port", "0"], {
      cwd: world.dir,
      env: {},
      stdout: (l) => out.push(l),
      stderr: () => {},
      signal: controller.signal,
    });
    expect(code).toBe(0);
  });
});
