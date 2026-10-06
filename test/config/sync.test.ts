// syncCatalog against a real HTTP server on the loopback interface (the network is never used): a valid
// answer, a changed one, the answers that must leave the old catalog alone, and a server that hangs.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MAX_CATALOG_BYTES, syncCatalog } from "../../src/lib/catalog.js";
import { tempDir } from "../support/index.js";
import { catalog, entry } from "./helpers.js";
import { fileWith, json, serve, status, stopLast, type Handler } from "./server.js";

describe("syncCatalog: a conforming answer", () => {
  test("is written, pretty-printed, and the same answer again changes nothing", async () => {
    const url = await serve(json(catalog()));
    const dir = tempDir();
    const out = join(dir, "data", "projects.snapshot.json");

    const first = await syncCatalog({ url, out });
    expect(first).toMatchObject({ ok: true, outcome: "written" });
    expect(first.message).toBe("wrote 1 projects (generated 2026-10-05T00:00:00Z)");
    expect(readFileSync(out, "utf8")).toBe(`${JSON.stringify(catalog(), null, 2)}\n`);

    const again = await syncCatalog({ url, out });
    expect(again).toMatchObject({ ok: true, outcome: "unchanged" });
    expect(again.message).toBe("already current (1 projects)");
    expect(readdirSync(join(dir, "data"))).toEqual(["projects.snapshot.json"]);
  });

  test("replaces an older catalog", async () => {
    const url = await serve(
      json(catalog([entry(), entry({ slug: "b", repo: "https://github.com/Avunu/b" })])),
    );
    const { out } = fileWith(JSON.stringify(catalog()));
    expect(await syncCatalog({ url, out })).toMatchObject({ ok: true, outcome: "written" });
    expect(JSON.parse(readFileSync(out, "utf8")).projects).toHaveLength(2);
  });

  test("sends an Accept header for JSON and follows a redirect", async () => {
    let accept: string | undefined;
    const target = await serve((request, response) => {
      accept = request.headers.accept;
      json(catalog())(request, response);
    });
    const url = await serve((_request, response) => {
      response.statusCode = 301;
      response.setHeader("location", target);
      response.end();
    });
    const { out } = fileWith("OLD");
    expect(await syncCatalog({ url, out })).toMatchObject({ ok: true, outcome: "written" });
    expect(accept).toBe("application/json");
  });

  test("creates the folders above the file", async () => {
    const url = await serve(json(catalog()));
    const out = join(tempDir(), "a", "b", "c.json");
    expect(await syncCatalog({ url, out })).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(out, "utf8")).version).toBe(1);
  });
});

describe("syncCatalog: every other answer leaves the old catalog alone and says why", () => {
  const cases: Array<[string, Handler, "not-live" | "invalid" | "failed", RegExp]> = [
    [
      "404",
      status(404, "not found"),
      "not-live",
      /answered 404: no catalog is published there \(yet\)/,
    ],
    ["410", status(410), "not-live", /answered 410/],
    ["500", status(500, "oops"), "failed", /answered 500$/],
    ["503", status(503), "failed", /answered 503$/],
    ["403", status(403), "failed", /answered 403$/],
    ["not JSON", json("<html>"), "invalid", /did not return JSON/],
    ["an empty body", json(""), "invalid", /did not return JSON/],
    [
      "a list",
      json("[]"),
      "invalid",
      /does not match the catalog contract:\n {2}- the document is not a JSON object/,
    ],
    [
      "the wrong version",
      json({ ...catalog(), version: 9 }),
      "invalid",
      /"version" must be 1 \(got 9\)/,
    ],
    [
      "an empty list of projects",
      json({ ...catalog(), projects: [] }),
      "invalid",
      /"projects" is empty/,
    ],
    [
      "a bad platform",
      json(catalog([entry({ platform: "x" })])),
      "invalid",
      /frappe-nix: "platform" must be one of/,
    ],
  ];

  test.each(cases)("%s", async (_label, handler, outcome, message) => {
    const url = await serve(handler);
    const { dir, out } = fileWith("OLD");
    const result = await syncCatalog({ url, out });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe(outcome);
    expect(result.message).toMatch(message);
    expect(readFileSync(out, "utf8")).toBe("OLD");
    expect(readdirSync(dir)).toEqual(["snapshot.json"]);
  });

  test("at most eight problems of a bad document are listed", async () => {
    const bad = Array.from({ length: 20 }, (_, i) => entry({ slug: `p${i}`, platform: "x" }));
    const url = await serve(json(catalog(bad)));
    const { out } = fileWith("OLD");
    const result = await syncCatalog({ url, out });
    expect(result.message.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(8);
  });

  test("nobody listening", async () => {
    const url = await serve(status(200));
    await stopLast();
    const { out } = fileWith("OLD");
    const result = await syncCatalog({ url, out, timeoutMs: 2000 });
    expect(result).toMatchObject({ ok: false, outcome: "failed" });
    expect(result.message).toContain(`could not fetch ${url}`);
    expect(readFileSync(out, "utf8")).toBe("OLD");
  });

  test("a server that never answers: falls back after the timeout, and says it timed out", async () => {
    const url = await serve(() => {
      // never answers
    });
    const { out } = fileWith("OLD");
    const started = Date.now();
    const result = await syncCatalog({ url, out, timeoutMs: 150 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result).toMatchObject({ ok: false, outcome: "failed" });
    expect(result.message).toBe(`could not fetch ${url} (timed out after 150 ms)`);
    expect(readFileSync(out, "utf8")).toBe("OLD");
  });

  test("a server that answers the headers and then stalls", async () => {
    const url = await serve((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.write('{"version": 1, ');
      // never ends
    });
    const { out } = fileWith("OLD");
    const result = await syncCatalog({ url, out, timeoutMs: 150 });
    expect(result).toMatchObject({ ok: false, outcome: "failed" });
    expect(result.message).toContain("timed out after 150 ms");
    expect(readFileSync(out, "utf8")).toBe("OLD");
  });

  test("an answer that is too large: by its declared size and by what it sends", async () => {
    const big = "x".repeat(MAX_CATALOG_BYTES + 1);
    const declared = await serve(json(big));
    const streamed = await serve((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.write(big.slice(0, MAX_CATALOG_BYTES / 2));
      response.write(big.slice(0, MAX_CATALOG_BYTES / 2));
      response.end(big.slice(0, 1024));
    });
    const { out } = fileWith("OLD");
    for (const url of [declared, streamed]) {
      const result = await syncCatalog({ url, out, timeoutMs: 10_000 });
      expect(result).toMatchObject({ ok: false, outcome: "failed" });
      expect(result.message).toContain(`answered more than ${MAX_CATALOG_BYTES} bytes`);
    }
    expect(readFileSync(out, "utf8")).toBe("OLD");
  });

  test("a file that cannot be written is a failure, not a throw", async () => {
    const url = await serve(json(catalog()));
    const dir = tempDir();
    mkdirSync(join(dir, "blocked"));
    const result = await syncCatalog({ url, out: join(dir, "blocked") });
    expect(result).toMatchObject({ ok: false, outcome: "failed" });
    expect(result.message).toContain("could not write");
    expect(readdirSync(dir)).toEqual(["blocked"]);
  });

  test("never throws, whatever the address is", async () => {
    const { out } = fileWith("OLD");
    for (const url of ["not a url", "http://", "ftp://127.0.0.1/x"]) {
      const result = await syncCatalog({ url, out, timeoutMs: 500 });
      expect(result.ok, url).toBe(false);
    }
    expect(readFileSync(out, "utf8")).toBe("OLD");
  });
});
