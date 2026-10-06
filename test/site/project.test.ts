// Checks on the Jx project files of site/ themselves (ported from the starter's project.test.ts and
// the prototype's, with the import changes and the additions of section 9.1 "site"): every document
// parses, every component is registered under its own tag, every layout, page and content type
// binds to a file or a name that exists, every design token that is used is defined, the
// JavaScript in state entries is valid, the project switcher's logic (which lives twice, once at
// build time in the base layout and once in the browser in the component) is the same text and
// gives the right groups, and the interactive parts keep their accessible structure.
import { readdirSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { describe, expect, test } from "vitest";
import { SAMPLE_CATALOG, catalog, entry } from "./support/catalog.js";
import {
  COMPONENTS,
  JX_PACKAGES,
  LAYOUTS,
  PAGES,
  PROJECT,
  SITE,
  bodies,
  exists,
  nodes,
  readJson,
  readText,
  type Json,
} from "./support/site.js";

const DOCUMENTS = ["project.base.json", ...COMPONENTS, ...LAYOUTS, ...PAGES];

describe("the documents", () => {
  test("there are 12 components, 2 layouts and 3 pages, all valid JSON", () => {
    expect(COMPONENTS).toHaveLength(12);
    expect(LAYOUTS).toEqual(["layouts/base.json", "layouts/docs.json"]);
    expect(PAGES).toEqual(["pages/404.json", "pages/[...path].json", "pages/index.json"]);
    for (const file of DOCUMENTS) expect(() => JSON.parse(readText(file)), file).not.toThrow();
  });

  test("a component's file name is its tag, and tags and ids are unique", () => {
    const tags = new Set<string>();
    const ids = new Set<string>();
    for (const file of COMPONENTS) {
      const component = readJson(file);
      const tag = String(component.tagName);
      expect(basename(file, ".json"), file).toBe(tag);
      expect(tag, file).toContain("-");
      expect(tags.has(tag), `${file} repeats ${tag}`).toBe(false);
      tags.add(tag);
      expect(typeof component.$id, file).toBe("string");
      expect(ids.has(component.$id), `${file} repeats ${component.$id}`).toBe(false);
      ids.add(component.$id);
    }
  });

  test("components are flat: nothing but .json files sits in components/", () => {
    expect(readdirSync(join(SITE, "components")).filter((f) => !f.endsWith(".json"))).toEqual([]);
  });
});

describe("every document binds to files and names that exist", () => {
  /** A root-relative path of a reference such as `./layouts/base.json`. */
  const resolve = (ref: string): string => posix.normalize(ref.replace(/^\.\//, ""));

  test("layout chains end, and every layout named is a file of site/", () => {
    expect(resolve(PROJECT.defaults.layout)).toBe("layouts/base.json");
    expect(exists("layouts/base.json")).toBe(true);
    for (const file of [...LAYOUTS, ...PAGES]) {
      let current = file;
      for (let hops = 0; ; hops += 1) {
        expect(hops, `${file}: the $layout chain does not end`).toBeLessThan(5);
        const next = readJson(current).$layout as string | undefined;
        if (!next) break;
        current = resolve(next);
        expect(exists(current), `${file}: $layout ${next} is not a file of site/`).toBe(true);
      }
    }
  });

  test("the chain is page, then the docs layout (documentation pages only), then the base layout", () => {
    expect(readJson("layouts/base.json").$layout).toBeUndefined();
    expect(readJson("pages/index.json").$layout).toBe("./layouts/base.json");
    expect(readJson("pages/404.json").$layout).toBe("./layouts/base.json");
    expect(readJson("pages/[...path].json").$layout).toBe("./layouts/docs.json");
    expect(readJson("layouts/docs.json").$layout).toBe("./layouts/base.json");
  });

  test("the elements registered for Markdown directives are components of site/", () => {
    const refs = PROJECT.content.docs.$elements as Array<{ $ref: string }>;
    expect(refs.map((r) => r.$ref)).toEqual(["./components/docs-callout.json"]);
    for (const { $ref } of refs) expect(exists(resolve($ref)), $ref).toBe(true);
    // Every alert type is rendered by a registered component.
    const tags = new Set(COMPONENTS.map((file) => readJson(file).tagName as string));
    for (const tag of Object.values(PROJECT.content.docs.alerts as Record<string, string>)) {
      expect(tags.has(tag), tag).toBe(true);
    }
  });

  test("every custom element used is a registered component, and every component is used", () => {
    // Jx ignores an unregistered tag and emits it empty, and the build still exits 0.
    const registered = new Set(COMPONENTS.map((file) => readJson(file).tagName as string));
    const usedBy = new Map<string, Set<string>>();
    const use = (tag: string, by: string): void => {
      usedBy.set(tag, (usedBy.get(tag) ?? new Set()).add(by));
    };
    for (const file of [...COMPONENTS, ...LAYOUTS, ...PAGES]) {
      for (const node of nodes(readJson(file), (n) => typeof n.tagName === "string")) {
        const tag = String(node.tagName);
        if (tag.includes("-") && file !== `components/${tag}.json`) use(tag, file);
      }
    }
    // The alert component is not named in any document: Markdown alerts are rendered as it.
    for (const tag of Object.values(PROJECT.content.docs.alerts as Record<string, string>)) {
      use(tag, "project.base.json");
    }
    expect([...usedBy.keys()].filter((tag) => !registered.has(tag))).toEqual([]);
    expect([...registered].filter((tag) => !usedBy.has(tag))).toEqual([]);
  });

  test("only the four Jx packages the CLI links into the root are named, as extensions or by $src", () => {
    for (const extension of PROJECT.extensions as string[]) {
      expect(JX_PACKAGES as readonly string[], extension).toContain(extension);
    }
    const packages = new Set<string>();
    for (const file of [...COMPONENTS, ...LAYOUTS, ...PAGES]) {
      for (const node of nodes(readJson(file), (n) => typeof n.$src === "string")) {
        const src = String(node.$src);
        expect(src, `${file}: a sidecar file is not allowed, only npm: packages`).toMatch(/^npm:/);
        const parts = src.slice("npm:".length).split("/");
        packages.add(`${parts[0]}/${parts[1]}`);
      }
    }
    expect([...packages]).toEqual(["@jxsuite/search"]);
  });

  test("content types: the four sources and file names are the frozen ones, and ids name the files", () => {
    const content = PROJECT.content as Record<string, Json>;
    expect(Object.fromEntries(Object.entries(content).map(([k, v]) => [k, v.source]))).toEqual({
      docs: "./.generated/docs",
      nav: "./.generated/nav.json",
      config: "./docusystem.config.json",
      projects: "./data/projects.snapshot.json",
    });
    expect(content.docs!.format).toBe("Markdown");
    for (const name of ["nav", "config", "projects"]) expect(content[name]!.format).toBe("json");
    // A `ContentEntry` of a layout or page names a content type of the project and, for the
    // single-document types, the file stem Jx derives the id from.
    const stem = (type: string): string =>
      basename(String(content[type]!.source)).replace(/\.json$/, "");
    const entries: Array<[string, Json]> = [];
    for (const file of [...LAYOUTS, ...PAGES]) {
      for (const node of nodes(readJson(file), (n) => n.$prototype === "ContentEntry")) {
        entries.push([file, node]);
      }
    }
    for (const [file, node] of entries) {
      expect(Object.keys(content), file).toContain(node.contentType);
      if (node.contentType !== "docs") {
        expect(node.id, `${file} ${node.contentType}`).toBe(stem(node.contentType));
      }
    }
    expect(entries.map(([file, n]) => `${file} ${n.contentType}:${n.id ?? ""}`)).toEqual([
      "layouts/base.json config:docusystem.config",
      "layouts/base.json projects:projects.snapshot",
      "layouts/base.json nav:nav",
      "pages/[...path].json docs:",
    ]);
    // The catch-all page serves the docs collection.
    expect(readJson("pages/[...path].json").$paths).toEqual({ contentType: "docs" });
  });

  test("the layouts read the resolved config, the catalog and the nav under the names the pages use", () => {
    const base = readJson("layouts/base.json").state;
    expect(base.config).toMatchObject({ contentType: "config", id: "docusystem.config" });
    expect(base.catalog).toMatchObject({ contentType: "projects", id: "projects.snapshot" });
    expect(base.nav).toMatchObject({ contentType: "nav", id: "nav" });
  });

  test("the search collection covers the docs routes", () => {
    expect(PROJECT.search.output).toBe("/search-index.json");
    expect(PROJECT.search.collections.docs.basePath).toBe("/docs/");
    expect(PROJECT.content.docs.route.startsWith("/docs/")).toBe(true);
    expect(PROJECT.content.docs.indexRoute.startsWith("/docs/")).toBe(true);
  });
});

describe("fonts, marks and favicons", () => {
  const referenced = (): string[] => {
    const found = new Set<string>();
    for (const file of DOCUMENTS) {
      for (const m of readText(file).matchAll(
        /\/(?:fonts|brand)\/[\w.-]+\.(?:woff2|svg|png)|\/favicon\.(?:svg|ico)/g,
      )) {
        found.add(m[0].slice(1));
      }
    }
    return [...found].sort();
  };

  test("every font, mark and favicon a document names is a file of site/public", () => {
    const names = referenced();
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) expect(exists(`public/${name}`), name).toBe(true);
  });

  test("all six font files are used, and no file of public/fonts is unused", () => {
    const used = new Set(referenced().filter((n) => n.startsWith("fonts/")));
    const shipped = readdirSync(join(SITE, "public", "fonts")).filter((n) => n.endsWith(".woff2"));
    expect(shipped).toHaveLength(6);
    expect([...used].sort()).toEqual(shipped.map((n) => `fonts/${n}`).sort());
  });

  test("each font family ships its SIL Open Font License text", () => {
    const families: Array<[string, string, string]> = [
      ["figtree-", "LICENSE-Figtree.txt", "Figtree"],
      ["jetbrains-mono-", "LICENSE-JetBrainsMono.txt", "JetBrains Mono"],
    ];
    for (const [, license, family] of families) {
      const text = readText(`public/fonts/${license}`);
      expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(text).toContain(family);
      expect(text).toMatch(/Copyright/);
    }
    for (const font of readdirSync(join(SITE, "public", "fonts")).filter((n) =>
      n.endsWith(".woff2"),
    )) {
      expect(
        families.some(
          ([prefix, license]) => font.startsWith(prefix) && exists(`public/fonts/${license}`),
        ),
        `${font} has no license text`,
      ).toBe(true);
    }
  });

  test("the fonts are self-hosted: six local @font-face rules, swapped in, and no third-party host in any document", () => {
    const faces = readJson("layouts/base.json").style["@font-face"] as Json[];
    expect(faces).toHaveLength(6);
    for (const face of faces) {
      expect(face.src, face["font-family"]).toMatch(
        /^url\("\/fonts\/[\w-]+\.woff2"\) format\("woff2"\)$/,
      );
      expect(face["font-display"]).toBe("swap");
    }
    expect([...new Set(faces.map((f) => f["font-family"]))].sort()).toEqual([
      "Figtree",
      "JetBrains Mono",
    ]);
    expect(DOCUMENTS.map((f) => readText(f)).join("\n")).not.toMatch(
      /fonts\.(?:googleapis|gstatic)\.com|typekit|bunny\.net|cdn\./,
    );
    const hosts = new Set<string>();
    for (const file of DOCUMENTS) {
      for (const m of readText(file).matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) hosts.add(m[1]!);
    }
    // Only avunu.net and the placeholder host of the base project (replaced when project.json is
    // generated): the repository links are built from the configured repository.
    expect([...hosts].sort()).toEqual(["avunu.net", "project-name.avunu.net"]);
  });
});

describe("design tokens", () => {
  /** Every `--name` that is defined (as a key) or used (inside var()) in a JSON document. */
  function tokens(value: unknown, defined = new Set<string>(), used = new Set<string>()) {
    if (typeof value === "string") {
      for (const m of value.matchAll(/var\((--[\w-]+)/g)) used.add(m[1]!);
    } else if (Array.isArray(value)) {
      for (const v of value) tokens(v, defined, used);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (k.startsWith("--")) defined.add(k);
        tokens(v, defined, used);
      }
    }
    return { defined, used };
  }

  test("every token that is used is defined, and the dark theme only overrides tokens that exist", () => {
    const defined = new Set<string>(Object.keys(PROJECT.style).filter((k) => k.startsWith("--")));
    const own = new Set<string>();
    const used = new Set<string>();
    for (const file of DOCUMENTS) {
      const t = tokens(readJson(file));
      t.used.forEach((u) => used.add(u));
      if (file !== "project.base.json") t.defined.forEach((d) => own.add(d)); // a component may define a local property
    }
    // --shiki-light and --shiki-dark are set by the code highlighter on each token, not by the project.
    const missing = [...used].filter(
      (u) => !defined.has(u) && !own.has(u) && !u.startsWith("--shiki-"),
    );
    expect(missing).toEqual([]);
    for (const name of Object.keys(PROJECT.style["@--dark"])) {
      expect(defined.has(name), `${name} is overridden in dark but not defined`).toBe(true);
    }
  });

  test("components, layouts and pages use tokens, never raw hex colours", () => {
    for (const file of [...COMPONENTS, ...LAYOUTS, ...PAGES]) {
      // A colour is 3, 4, 6 or 8 hex digits after `#`; "#main" and "#top" are anchors.
      const hex = (readText(file).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter(
        (h) => [4, 5, 7, 9].includes(h.length) && /^#[0-9a-fA-F]+$/.test(h),
      );
      expect(
        hex.filter((c) => !["#main", "#top"].includes(c)),
        file,
      ).toEqual([]);
    }
  });

  test("the browser's theme-color meta tags are the page colours of the two themes", () => {
    const metas = (PROJECT.$head as Json[]).filter((h) => h.attributes?.name === "theme-color");
    const byMedia = Object.fromEntries(
      metas.map((m) => [m.attributes.media, m.attributes.content]),
    );
    expect(byMedia["(prefers-color-scheme: light)"]).toBe(PROJECT.style["--color-bg"]);
    expect(byMedia["(prefers-color-scheme: dark)"]).toBe(PROJECT.style["@--dark"]["--color-bg"]);
  });

  test("the search highlight is a tint of the action colour with the text colour on it", () => {
    // The contrast gate (WP4) reads exactly this rule; test/site/contrast.test.ts runs the gate on it.
    const rule = (readJson("components/docs-search.json").style as Json)["& .hl"] as Json;
    expect(rule.backgroundColor).toBe("color-mix(in srgb, var(--color-action) 22%, transparent)");
    expect(rule.color).toBe("var(--color-text)");
  });
});

describe("the JavaScript in the documents", () => {
  test("every Function body is valid JavaScript", () => {
    let count = 0;
    for (const file of [...COMPONENTS, ...LAYOUTS, ...PAGES]) {
      for (const { where, body } of bodies(readJson(file))) {
        count += 1;
        expect(
          () => new Function("state", `return (async function () { ${body}\n}).call(this)`),
          `${file} ${where}`,
        ).not.toThrow();
      }
    }
    expect(count).toBeGreaterThan(15);
  });

  test("a compiler-timed Function has no sidecar", () => {
    for (const file of [...LAYOUTS, ...PAGES]) {
      for (const [key, value] of Object.entries((readJson(file).state ?? {}) as Json)) {
        if (value?.timing === "compiler" && value.$prototype === "Function") {
          expect(value.$src, `${file} state.${key}`).toBeUndefined();
        }
      }
    }
  });

  test("every layout and page derives its values at build time, so pages ship no JavaScript of their own", () => {
    for (const file of [...LAYOUTS, ...PAGES]) {
      for (const [key, value] of Object.entries((readJson(file).state ?? {}) as Json)) {
        const ok = typeof value === "object" && value !== null && value.timing === "compiler";
        expect(ok, `${file} state.${key} must be compiler-timed`).toBe(true);
      }
    }
  });
});

describe("the project switcher", () => {
  const between = (text: string): string => {
    const a = text.indexOf("// switcher:start");
    const b = text.indexOf("// switcher:end");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return text.slice(a, b + "// switcher:end".length);
  };
  const layoutBody: string = readJson("layouts/base.json").state.switcherGroups.body;
  const componentBody: string = readJson("components/project-switcher.json").state.onMount.body;

  const groups = (data: unknown, current: string) =>
    new Function("state", layoutBody)({
      catalog: { data },
      config: { data: { slug: current } },
    }) as Array<{ platform: string; label: string; items: Array<Json> }>;

  test("the grouping logic is the same text at build time and in the browser", () => {
    expect(between(componentBody)).toBe(between(layoutBody));
  });

  test("projects are grouped by platform in the fixed order, sorted by title, with the current one marked", () => {
    const result = groups(
      catalog([
        entry("b", "odoo"),
        entry("z", "nixos"),
        entry("a", "frappe"),
        entry("c", "odoo"),
        entry("m", "mystery"),
      ]),
      "z",
    );
    expect(result.map((g) => g.label)).toEqual(["Frappe & ERPNext", "Odoo", "NixOS", "mystery"]);
    expect(result[1]!.items.map((i) => i.title)).toEqual(["B", "C"]);
    const current = result.flatMap((g) => g.items).filter((i) => i.current);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ slug: "z", caption: "You are here" });
  });

  test("an entry links to its docs site when it has one, else to its avunu.net page", () => {
    const items = groups(
      catalog([entry("a", "frappe", { docs: "https://a.avunu.net" }), entry("b", "frappe")]),
      "none",
    )[0]!.items;
    expect(items[0]).toMatchObject({ href: "https://a.avunu.net", caption: "Docs" });
    expect(items[1]).toMatchObject({
      href: "https://avunu.net/open-source/b/",
      caption: "avunu.net",
    });
  });

  test("malformed entries and non-https links are dropped", () => {
    const result = groups(
      catalog([
        entry("ok", "frappe"),
        { slug: "x" },
        entry("bad", "frappe", { page: "javascript:alert(1)" }),
        entry("worse", "frappe", { page: "http://insecure.example", docs: "javascript:1" }),
        null,
      ]),
      "none",
    );
    expect(result.flatMap((g) => g.items.map((i) => i.slug))).toEqual(["ok"]);
    expect(groups({ ...catalog([]), version: 2 }, "none")).toEqual([]);
    expect(groups(null, "none")).toEqual([]);
  });

  test("a catalog with every platform builds every group, from a fixed fixture", () => {
    const fixture = catalog([
      entry("a", "frappe"),
      entry("b", "odoo"),
      entry("c", "wordpress"),
      entry("d", "nixos"),
      entry("e", "general"),
    ]);
    const result = groups(fixture, "d");
    expect(result.map((g) => g.platform)).toEqual([
      "frappe",
      "odoo",
      "wordpress",
      "nixos",
      "general",
    ]);
    expect(result.flatMap((g) => g.items)).toHaveLength(5);
  });

  test("the sample catalog of the build test is grouped as the build test expects", () => {
    const result = groups(SAMPLE_CATALOG, "example");
    expect(result.map((g) => g.platform)).toEqual(["frappe", "odoo", "nixos", "general"]);
    expect(result.flatMap((g) => g.items).filter((i) => i.current)).toHaveLength(1);
  });

  // The bundled catalog is WP1's (site/data/projects.snapshot.json); until it is merged there is
  // nothing to read, and the test below starts running with it.
  test.skipIf(!exists("data/projects.snapshot.json"))(
    "whatever the live catalog holds, the bundled snapshot builds into groups without a throw",
    () => {
      // A weekly job refreshes the snapshot from avunu.net: it may have one project or one
      // platform, and the tests must not care. Every entry of a valid catalog is listed once.
      const snapshot = JSON.parse(readText("data/projects.snapshot.json"));
      const result = groups(snapshot, "frappe-nix");
      expect(result.flatMap((g) => g.items)).toHaveLength(snapshot.projects.length);
      for (const one of [
        catalog([entry("only", "nixos")]),
        catalog([entry("a", "odoo"), entry("b", "odoo")]),
      ]) {
        expect(groups(one, "none").flatMap((g) => g.items)).toHaveLength(one.projects.length);
      }
    },
  );

  test("a bad entry never discards the others, and the catalog cannot flood or confuse the list", () => {
    const result = groups(
      catalog([
        entry("ok", "frappe"),
        entry("__proto__", "constructor"),
        entry("constructor", "frappe"),
        entry("dup", "frappe", { title: "First" }),
        entry("dup", "frappe", { title: "Second" }),
        entry("blank", "frappe", { title: "   " }),
        entry("long", "frappe", { title: "x".repeat(500) }),
        entry("evil", "frappe", { page: "https://evil.example/phish", docs: null }),
        entry("userinfo", "frappe", { page: "https://avunu.net@evil.example/" }),
        {
          slug: "throws",
          title: "T",
          platform: "frappe",
          get page(): string {
            throw new Error("boom");
          },
        },
        entry("late", "nixos"),
      ]),
      "ok",
    );
    const items = result.flatMap((g) => g.items);
    expect(items.map((i) => i.slug).sort()).toEqual(
      ["__proto__", "constructor", "dup", "evil", "late", "long", "ok", "userinfo"].sort(),
    );
    expect(items.find((i) => i.slug === "dup")!.title).toBe("First");
    expect(items.find((i) => i.slug === "long")!.title).toHaveLength(120);
    expect(items.filter((i) => i.current)).toHaveLength(1);
    // The caption names the host the link goes to, whatever it is.
    expect(items.find((i) => i.slug === "evil")!.caption).toBe("evil.example");
    expect(items.find((i) => i.slug === "userinfo")!.caption).toBe("evil.example");
    // A platform with a name that is a property of Object does not break the groups.
    expect(result.map((g) => g.label)).toContain("constructor");
    const many = groups(
      catalog(Array.from({ length: 1000 }, (_v, i) => entry(`p${i}`, "frappe"))),
      "none",
    );
    expect(many.flatMap((g) => g.items)).toHaveLength(300);
  });
});

describe("the content type of the docs", () => {
  test("mirrors what docs.ts and nav.ts (WP3) assume: exclude, where, routes, alerts and fields", () => {
    const docs = PROJECT.content.docs;
    expect(docs.route).toBe("/docs/{id:slug}/");
    expect(docs.indexRoute).toBe("/docs/{dir:slug}/");
    expect(docs.where).toEqual({ draft: { $ne: true }, publish: { $ne: false } });
    expect(docs.exclude).toEqual(["**/node_modules/**", "**/.*", "**/.*/**", "**/_*", "**/_*/**"]);
    expect(Object.keys(docs.alerts).sort()).toEqual([
      "CAUTION",
      "IMPORTANT",
      "NOTE",
      "TIP",
      "WARNING",
    ]);
    // The front-matter keys of section 7.1: all optional, none required.
    expect(Object.keys(docs.schema.properties).sort()).toEqual(
      [
        "description",
        "draft",
        "hidden",
        "nav_title",
        "order",
        "publish",
        "tags",
        "title",
        "updated",
      ].sort(),
    );
    expect(docs.schema.required).toEqual([]);
  });

  test("links are generated per mode: the base says warn and the assembler overrides it", () => {
    expect(PROJECT.content.docs.links).toBe("warn");
    expect(PROJECT.build).toMatchObject({ outDir: "./dist", trailingSlash: "always" });
  });
});

describe("the interactive parts", () => {
  test("the search listbox holds options and nothing else; the status and the links sit beside it", () => {
    const search = readJson("components/docs-search.json");
    const [listbox] = nodes(search, (n) => n.attributes?.role === "listbox");
    expect(listbox).toBeDefined();
    const content = listbox!.children as Json[];
    expect(content).toHaveLength(1);
    expect(content[0]!.$prototype).toBe("Array");
    expect(content[0]!.map.attributes.role).toBe("option");
    // Nothing that is not an option is inside it (the empty-state text, the "Jump to" links).
    expect(nodes(listbox!, (n) => n.attributes?.role === "status")).toEqual([]);
    expect(nodes(listbox!, (n) => n.attributes?.class === "quick-link")).toEqual([]);
    expect(nodes(search, (n) => n.attributes?.role === "status")).toHaveLength(1);
    expect(nodes(search, (n) => n.attributes?.class === "quick-link")).toHaveLength(1);
    // An empty list is hidden rather than left as an empty listbox.
    expect(listbox!.attributes.hidden).toContain("searchResults.length === 0");
  });

  test("the project switcher is a disclosure of links, not a menu", () => {
    const switcher = readJson("components/project-switcher.json");
    expect(
      nodes(switcher, (n) => /^(menu|menuitem|menubar)$/.test(String(n.attributes?.role))),
    ).toEqual([]);
    const [button] = nodes(switcher, (n) => n.tagName === "button");
    expect(button!.attributes["aria-haspopup"]).toBeUndefined();
    expect(button!.attributes["aria-expanded"]).toBe("false");
    expect(button!.attributes.popovertarget).toBe("project-switcher-menu");
    const links = nodes(switcher, (n) => n.tagName === "a");
    expect(links.length).toBeGreaterThanOrEqual(3);
    // A link is named "Title, Docs": its title, then where it goes, with a separator a reader hears.
    for (const item of nodes(switcher, (n) => n.tagName === "li")) {
      const link = item.children[0];
      expect(link.attributes["aria-label"]).toMatch(/^.+, .+$/);
      expect(link.children.map((c: Json) => c.attributes.class)).toEqual(["t", "c"]);
    }
    // The keyboard code of a menu is gone with the roles.
    const body = switcher.state.onMount.body as string;
    expect(body).not.toContain("ArrowDown");
    expect(body).not.toContain("menuitem");
    expect(body).toContain("focusout");
  });

  test("the documentation drawer is made modal while it is open", () => {
    const enhance = readJson("components/docs-enhance.json").state.onMount.body as string;
    for (const part of ["docs-drawer", "inert", "aria-expanded", "aria-modal", ".drawer-close"]) {
      expect(enhance, part).toContain(part);
    }
    const [opener] = nodes(
      readJson("layouts/docs.json"),
      (n) => n.attributes?.class === "menu-btn",
    );
    expect(opener!.attributes["aria-expanded"]).toBe("false");
    expect(opener!.attributes.popovertarget).toBe("docs-drawer");
  });

  test("every page has the header with the switcher, search and theme toggle, and the footer", () => {
    const tags = nodes(readJson("layouts/base.json"), (n) => typeof n.tagName === "string").map(
      (n) => String(n.tagName),
    );
    for (const tag of [
      "docs-header",
      "project-switcher",
      "docs-search",
      "theme-toggle",
      "docs-footer",
      "docs-enhance",
    ]) {
      expect(tags, tag).toContain(tag);
    }
  });
});
