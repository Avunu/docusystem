// scripts/sync-catalog.mjs: what it decides (check, update, "not published yet", network trouble) is
// tested through `main`, with the TypeScript source of the library injected so that no build is needed;
// its command line, and the build it does when dist/ is missing, are tested through real processes.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import * as library from "../../src/lib/catalog.js";
import { REPO_ROOT, tempDir } from "../support/index.js";
import { catalog, entry } from "./helpers.js";
import { fileWith, json, serve, status } from "./server.js";

interface Script {
  main(
    argv: string[],
    io: { stdout: (line: string) => void; stderr: (line: string) => void },
    load: () => Promise<unknown>,
  ): Promise<number>;
  loadLibrary(root?: string): Promise<{ marker?: number }>;
}

const SCRIPT = join(REPO_ROOT, "scripts", "sync-catalog.mjs");
const script = (await import(pathToFileURL(SCRIPT).href)) as Script;

/** Runs the script in-process; `lines` are what it printed (errors after the output). */
async function run(
  argv: string[],
  load: () => Promise<unknown> = async () => library,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await script.main(
    argv,
    { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    load,
  );
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const store = (c: unknown): string => `${JSON.stringify(c, null, 2)}\n`;
const stamped = { ...catalog(), generated: "2027-02-03T04:05:06Z" };

describe("sync-catalog: --check", () => {
  test("is quiet and exits 0 when the content is the same, whatever `generated` says", async () => {
    const url = await serve(json(stamped));
    const { out } = fileWith(store(catalog()));
    const result = await run(["--check", "--url", url, "--out", out]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe(`sync-catalog: ${out} is current (1 projects)`);
    expect(readFileSync(out, "utf8")).toBe(store(catalog()));
  });

  test("exits 1 and lists the differences when the content differs, and writes nothing", async () => {
    const live = catalog([
      entry({ status: "stable" }),
      entry({ slug: "new", repo: "https://github.com/Avunu/new" }),
    ]);
    const url = await serve(json(live));
    const { dir, out } = fileWith(store(catalog()));
    const result = await run(["--check", "--url", url, "--out", out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      [
        `sync-catalog: ${out} differs from the live catalog:`,
        "  changed frappe-nix: status",
        "  added new (nixos)",
        "Run npm run sync-catalog to update it.",
      ].join("\n"),
    );
    expect(readFileSync(out, "utf8")).toBe(store(catalog()));
    expect(readdirSync(dir)).toEqual(["snapshot.json"]);
  });

  test("a file that is missing differs", async () => {
    const url = await serve(json(catalog()));
    const out = join(tempDir(), "missing.json");
    const result = await run(["--check", "--url", url, "--out", out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is missing or not JSON");
  });
});

describe("sync-catalog: updating", () => {
  test("replaces the file when the content changed, and says what changed", async () => {
    const live = {
      ...catalog([entry({ docs: "https://frappe-nix.avunu.net" })]),
      generated: "2027-01-01T00:00:00Z",
    };
    const url = await serve(json(live));
    const { dir, out } = fileWith(store(catalog()));
    const result = await run(["--url", url, "--out", out]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe(
      `sync-catalog: updated ${out} (1 projects):\n  changed frappe-nix: docs`,
    );
    expect(readFileSync(out, "utf8")).toBe(store(live));
    expect(readdirSync(dir)).toEqual(["snapshot.json"]);

    // the same answer again: nothing to do
    const again = await run(["--url", url, "--out", out]);
    expect(again).toMatchObject({
      code: 0,
      stdout: `sync-catalog: ${out} is current (1 projects)`,
    });
  });

  test("leaves the file alone when only `generated` changed (no release for a timestamp)", async () => {
    const url = await serve(json(stamped));
    const { out } = fileWith(store(catalog()));
    const result = await run(["--url", url, "--out", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("is current");
    expect(readFileSync(out, "utf8")).toBe(store(catalog()));
  });

  test("creates the file when there is none", async () => {
    const url = await serve(json(catalog()));
    const out = join(tempDir(), "projects.snapshot.json");
    const result = await run(["--url", url, "--out", out]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("updated");
    expect(readFileSync(out, "utf8")).toBe(store(catalog()));
  });

  test("by default refreshes the bundled catalog, which is the library's, and --out says otherwise", async () => {
    const bundled = readFileSync(library.bundledCatalogFile(), "utf8");
    const url = await serve(json(JSON.parse(bundled)));
    const count = (JSON.parse(bundled) as { projects: unknown[] }).projects.length;
    const result = await run(["--check", "--url", url]);
    expect(result).toMatchObject({
      code: 0,
      stdout: `sync-catalog: the bundled catalog is current (${count} projects)`,
    });
    expect(readFileSync(library.bundledCatalogFile(), "utf8")).toBe(bundled);
  });
});

describe("sync-catalog: not published yet, and trouble", () => {
  test.each(["--check", "update"])("a 404 is a notice and nothing changes (%s)", async (mode) => {
    const url = await serve(status(404));
    const { out } = fileWith("OLD");
    const result = await run([
      ...(mode === "--check" ? ["--check"] : []),
      "--url",
      url,
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `sync-catalog: notice: ${url} answered 404: no catalog is published there (yet); ${out} stays as it is`,
    );
    expect(result.stderr).toBe("");
    expect(readFileSync(out, "utf8")).toBe("OLD");
  });

  test.each(["--check", "update"])(
    "an answer that is not a catalog is a notice too (%s)",
    async (mode) => {
      const url = await serve(json({ ...catalog(), version: 2 }));
      const { out } = fileWith("OLD");
      const result = await run([
        ...(mode === "--check" ? ["--check"] : []),
        "--url",
        url,
        "--out",
        out,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("notice:");
      expect(result.stdout).toContain('"version" must be 1');
      expect(readFileSync(out, "utf8")).toBe("OLD");
    },
  );

  test.each(["--check", "update"])(
    "a catalog with a template expression is refused like any other that is not a catalog (%s)",
    async (mode) => {
      // What the weekly workflow would otherwise commit: the pull request would carry code that the
      // compiler evaluates in every site's build.
      const hostile = catalog([entry({ title: "T${process.cwd()}T" })]);
      const url = await serve(json(hostile));
      const { out } = fileWith("OLD");
      const result = await run([
        ...(mode === "--check" ? ["--check"] : []),
        "--url",
        url,
        "--out",
        out,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("notice:");
      expect(result.stdout).toContain('projects[0].title holds a "${"');
      expect(result.stdout).not.toContain("process.cwd");
      expect(readFileSync(out, "utf8")).toBe("OLD");
    },
  );

  test("a server error is a failure, exit 1", async () => {
    const url = await serve(status(500));
    const { out } = fileWith("OLD");
    for (const args of [["--check"], []]) {
      const result = await run([...args, "--url", url, "--out", out]);
      expect(result).toMatchObject({
        code: 1,
        stdout: "",
        stderr: `sync-catalog: ${url} answered 500`,
      });
    }
    expect(readFileSync(out, "utf8")).toBe("OLD");
  });

  test("a server that hangs is a failure after --timeout, and --soft makes it a warning", async () => {
    const url = await serve(() => {
      // never answers
    });
    const { out } = fileWith("OLD");
    const hard = await run(["--url", url, "--out", out, "--timeout", "150"]);
    expect(hard).toMatchObject({
      code: 1,
      stderr: `sync-catalog: could not fetch ${url} (timed out after 150 ms)`,
    });
    const soft = await run(["--soft", "--url", url, "--out", out, "--timeout", "150"]);
    expect(soft.code).toBe(0);
    expect(soft.stdout).toBe(
      `sync-catalog: warning: could not fetch ${url} (timed out after 150 ms); ${out} stays as it is`,
    );
    expect(readFileSync(out, "utf8")).toBe("OLD");
  });

  test("a library that cannot be loaded is a failure", async () => {
    const result = await run([], async () => {
      throw new Error("npm run build failed");
    });
    expect(result).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "sync-catalog: npm run build failed",
    });
  });
});

describe("sync-catalog: the command line", () => {
  test("--help", async () => {
    const result = await run(["--help"], async () => {
      throw new Error("not needed");
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: node scripts/sync-catalog.mjs");
  });

  test.each([
    [["--bogus"], /Unknown option '--bogus'/],
    [["extra"], /Unexpected argument 'extra'/],
    [["--timeout", "soon"], /--timeout must be a whole number of milliseconds \(got "soon"\)/],
    [["--timeout", "0"], /--timeout must be a whole number/],
    [["--url"], /argument missing/i],
  ])("%j is a usage error", async (argv, message) => {
    const result = await run(argv, async () => {
      throw new Error("not needed");
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(message);
  });

  test("as a real process: --help exits 0 and a bad option exits 2, without a build", () => {
    const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--check");
    const bad = spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("Unknown option '--nope'");
  });
});

describe("sync-catalog: the compiled library", () => {
  /** A stand-in package: a build script that writes dist/lib/catalog.js, and a source file. */
  function fakePackage(): string {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export {};\n");
    writeFileSync(
      join(root, "build.mjs"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'mkdirSync("dist/lib", { recursive: true });',
        'writeFileSync("dist/lib/catalog.js", "export const marker = 2;\\n");',
      ].join("\n"),
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "fake",
        private: true,
        type: "module",
        scripts: { build: "node build.mjs" },
      }),
    );
    return root;
  }

  test("is built first when dist/ is missing", async () => {
    const root = fakePackage();
    const loaded = await script.loadLibrary(root);
    expect(loaded.marker).toBe(2);
  });

  test("is built again when src/ is newer, and used as it is when it is not", async () => {
    const root = fakePackage();
    mkdirSync(join(root, "dist", "lib"), { recursive: true });
    const entryFile = join(root, "dist", "lib", "catalog.js");
    writeFileSync(entryFile, "export const marker = 1;\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, "src", "a.ts"), old, old);
    expect((await script.loadLibrary(root)).marker).toBe(1);

    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "src", "a.ts"), later, later);
    expect((await script.loadLibrary(root)).marker).toBe(2);
  });

  test("a build that fails is an error that says so", async () => {
    const root = fakePackage();
    writeFileSync(join(root, "build.mjs"), "process.exit(1);\n");
    await expect(script.loadLibrary(root)).rejects.toThrow("npm run build failed");
  });
});
