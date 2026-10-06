---
title: Build pipeline
description: The steps from a project's shell to the published dist folder, the generated Jx project root, the manifest, and how the dev server and CI use them.
order: 4
updated: 2026-10-06
tags: [reference, pipeline, jx]
---

`docusystem build` and `docusystem check` run one pipeline. Steps 1 to 14 are `build`; steps 15 to 17 are added by `check`. Every step prints with its stage prefix, and problems are collected rather than thrown until step 10.

## Why a generated project root

Jx 5.0.0 has no project-level composition. It reads `pages/`, `components/*.json` (flat), `public/` and the layout chain only from the project root, a nested layout is resolved against that root, components cannot be registered from a package, and `project.json` has no `extends`. So the package assembles a plain Jx project root from real file copies and runs the released Jx compiler on it with `jx build <root>`. That uses only documented Jx surfaces: no Jx extension, no hook, no mutation of Jx internals.

Jx also ignores what it does not understand and still exits 0: an unknown key, an unregistered component (an empty custom element is emitted). The pipeline therefore asserts the output positively (step 12).

## The steps

| Step | Stage        | What happens                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    |              | Environment gate: Node 22.19.0 or newer, and the workflow contract. Exit 3 otherwise.                                                                                                                                                                                                                                                                          |
| 1    | `preflight:` | Find the site folder; read and validate the config (all problems at once, exit 1); resolve the repository root, the docs folder (it must be inside the repository), the branch and the strictness.                                                                                                                                                             |
| 2    | `preflight:` | The docs home exists, with the `cp README.md docs/README.md` hint; the slug against the bundled catalog; a warning for starter leftovers in the site folder.                                                                                                                                                                                                   |
| 3    |              | Acquire `<site>/.docusystem/lock`. A dead pid is replaced; a live one is exit 3 naming it. Released at the end.                                                                                                                                                                                                                                                |
| 4    | `assemble:`  | Recreate `<site>/.docusystem/site` empty. Copy the package's `site/` into it, overlay the shell's `overrides/` and `public/`, generate `project.json`, the resolved config and `public/CNAME`, write the catalog snapshot, link the four Jx packages into `node_modules/@jxsuite/`, write `manifest.json`.                                                     |
| 5    | `stage:`     | Copy `docs/` to `<root>/.generated/docs` (dotfiles skipped, symlink policy applied). Rewrite links and images (Markdown and raw HTML: `<a href>`, `<img src>`) that point at repository files outside docs to GitHub URLs, and root-relative links to docs pages to page-relative ones. Move a leading comment below the front matter.                         |
| 6    | `lint:`      | Markdown checks over the original `docs/` with `file:line`: reference-style links, footnotes, task lists, `${...}` in link targets, unbalanced `<details>`, inline `<a href>` and the other rules. Errors are collected.                                                                                                                                       |
| 7    | `nav:`       | Compute the sidebar, previous and next links and the landing cards from the staged copy and write `<root>/.generated/nav.json`.                                                                                                                                                                                                                                |
| 8    |              | `docusystem jx` stops here and runs the pinned Jx with your arguments.                                                                                                                                                                                                                                                                                         |
| 9    | `jx:`        | Print the exact command, then run `<node> <compiler>/bin/jx.js build <root>` with the root as the working directory. Stdout and stderr are captured, echoed and written to `.docusystem/jx.log`. A non-zero exit is a failure, reported together with the lint errors.                                                                                         |
| 10   |              | Classify. Problems are the lint errors, Jx output lines matching `^(Content\b                                                                                                                                                                                                                                                                                  | Warning: | Error)`and skipped symbolic links. Parse`Done: N routes`: it must be at least the page count plus the static pages. Strict: print everything once and exit 1 with nothing published. Lenient: print them as warnings and continue. |
| 11   | `postbuild:` | On `<root>/dist`: tidy whitespace, escape `<title>`, set canonical and `og:url` with a trailing slash, move `404/index.html` to `404.html`, delete the per-page `index.md` copies, repair repository links in raw HTML, rewrite `sitemap.xml`, fix search-index titles, and warn (never fatally) about code fences in languages the highlighter does not know. |
| 12   | `assert:`    | Positive assertions on the result, each printed `ok` or `FAIL`. A failed assertion is fatal in every mode. See below.                                                                                                                                                                                                                                          |
| 13   |              | Publish: copy `<root>/dist` to a temporary folder beside `<site>/dist`, remove the old `<site>/dist` and rename the new one into place. Only after steps 10 and 12 passed (strict) or ran (lenient).                                                                                                                                                           |
| 14   |              | Print `build: N page(s) written to <site>/dist`, a one-line list of overrides and the manual `jx` command. Release the lock.                                                                                                                                                                                                                                   |
| 15   | `contrast:`  | (`check`) Resolve the effective tokens and the search highlight; run the WCAG pairs; any pair below its minimum fails.                                                                                                                                                                                                                                         |
| 16   | `links:`     | (`check`) Crawl `<site>/dist` with the nav data: every link, anchor, asset, search result and sidebar entry must resolve.                                                                                                                                                                                                                                      |
| 17   |              | (`check --ci`) Write the job summary and the step outputs; print `check: all steps passed` or `check: FAILED`.                                                                                                                                                                                                                                                 |

A failed strict build leaves the previous `<site>/dist` untouched.

### The assertions of step 12

- Every component file of the root was emitted as `components/<name>.js`.
- No registered custom element is left empty (not rendered).
- No page has an empty link: an `<a href>` with no text, image or `aria-label`. A raw HTML anchor in the Markdown is the usual cause, and step 6 reports it as a lint error with its file and line.
- Exactly one `<h1>` per page.
- The `<title>` of every page is text: the head has one `<title>` and one `</title>`. Jx writes the title text as it is, so a title that holds `</title>` would end the element and leave what follows it as live HTML in the head.
- No unevaluated template text in the output: a dollar sign, an opening brace and the word `state`, which would mean a page template was not evaluated.
- `CNAME` equals `domain`.
- At least one `fonts/*.woff2`; `@font-face` URLs are local; no third-party font host appears.
- `favicon.svg`, `favicon.ico` and `.nojekyll` exist.
- `search-index.json` has an entry for every docs page.
- `sitemap.xml` is present and on the configured domain.
- `404.html` is present and there is no `/404/` folder.
- There are no `*.md` copies.
- The project switcher is pre-rendered from the catalog.
- The route count of step 10.

## The generated project root

```text
<site>/.docusystem/                git-ignored; contains its own .gitignore with the single line *
  lock                             pid file
  manifest.json                    written by assemble
  jx.log                           raw stdout and stderr of the last Jx run
  serve/                           dev only: the copy of dist the dev server answers from
  site/                            THE JX PROJECT ROOT (recreated empty on every run)
    project.json                   generated from the package's project.base.json
    docusystem.config.json         the resolved config
    components/ layouts/ pages/    package copies, then overrides on top
    public/                        package public/, then <site>/public/, then CNAME
    data/projects.snapshot.json    the bundled catalog
    .generated/docs/               the staged Markdown
    .generated/nav.json            sidebar, previous and next, landing cards
    node_modules/@jxsuite/         links to the installed compiler, parser, runtime and search
    dist/                          the Jx build output, post-processed in place
<site>/dist/                       the published copy; the only path CI uploads
```

The layouts and pages read the resolved config through the content type `config`, the sidebar through `nav` and the project switcher through `projects`; the `docs` content type reads `./.generated/docs`.

### The manifest

`.docusystem/manifest.json` records what the build did:

```json
{
  "docusystem": "0.1.0",
  "runtime": "node 24.21.0",
  "jx": {
    "@jxsuite/compiler": "5.0.0",
    "@jxsuite/parser": "2.0.0",
    "@jxsuite/runtime": "4.0.3",
    "@jxsuite/search": "0.4.0"
  },
  "files": {
    "components/docs-footer.json": "override",
    "pages/index.json": "package",
    "project.json": "generated",
    "public/CNAME": "generated"
  },
  "shadowed": ["components/docs-footer.json"],
  "added": ["pages/about.json"],
  "catalog": "bundled",
  "strict": true
}
```

`files` lists every file of the root except `node_modules/`, `dist/` and `.generated/docs/`, sorted by path, with its origin: `package`, `override` or `generated`. `catalog` is `bundled`, or `live` with `--refresh-catalog`. The versions in the example are an illustration of the shape; the file records the ones installed.

## The catalog

The project switcher is built from a catalog bundled in the package, so the build needs no network and the output does not depend on avunu.net at build time. A weekly job in this repository proposes a refresh as a patch release. In the browser the page swaps in the live `https://avunu.net/projects.json` when idle. `--refresh-catalog` makes a build fetch the live one (a 5-second timeout) and accept it only if it passes the version-1 contract; otherwise the build keeps the bundled one and prints a `catalog:` warning. The contract bounds the text as well as the shape: a slug is a [config](configuration.md) slug, and no string in the document may hold `${`, `<`, `>` or a control character, because the compiler evaluates a `${...}` in what a page renders and a catalog that held one would run code in every site's build.

## The dev server

`docusystem dev` runs steps 1 to 14 leniently once. Then it serves `<site>/.docusystem/serve`, an atomically swapped copy of `<site>/dist`, on `127.0.0.1:<port>` with GitHub Pages semantics:

- A directory without a trailing slash answers 301.
- A missing path answers 404 with `404.html`.
- Path traversal is refused.
- An event stream at `/__reload` and a reload script injected before `</body>` of HTML pages reload the browser.

It watches the docs folder, `overrides/`, `public/` and the config file. Changes are debounced by 150 ms and rebuilds are serialized: one more only if a change arrived during a build. The lock is held only during a build. A failed rebuild keeps serving the last good copy and prints the problems, and the browser reloads only after a successful build. It binds only to loopback.

## What CI runs

Pull request (`docs.yml` calling `docs-build.yml`, token `contents: read`): check out without credentials; require `package-lock.json` and refuse `bun.lock`; Node 24 without a package cache; `npm ci --ignore-scripts`; `npm audit signatures` and the provenance assertion; `CI=true ./node_modules/.bin/docusystem check --ci`; upload `<site>/dist` as the 7-day artifact `docs-site` for review; on failure upload the debug artifact.

Push to the default branch or a manual run (`docs-publish.yml`): the same build job, with the Pages artifact when `DOCS_SITE_ENABLED` is `true`, then, only when it is, `docs-deploy.yml`. See [Workflows](workflows.md).
