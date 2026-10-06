---
title: Troubleshooting
description: Messages the commands print, what causes them and how to fix them, and how to look inside a build when something is wrong.
order: 6
updated: 2026-10-06
tags: [guide, troubleshooting, debugging]
---

Every message starts with the stage that printed it (`preflight:`, `assemble:`, `stage:`, `lint:`, `nav:`, `jx:`, `postbuild:`, `assert:`, `contrast:`, `links:`, `overrides:` or `catalog:`). The exit code says which kind of problem it is: 1 a problem was found, 2 a usage error, 3 the environment. See [exit codes](../reference/command-line.md#exit-codes).

## Node is too old

```text
docusystem: Node 20.11.0 is too old: @avunu/docusystem 0.1.0 needs Node 22.19.0 or newer (Bun 1.4 or newer also works). Install a current Node from https://nodejs.org/ and run it again.
```

Exit 3, before any other work. The floor is the highest Node requirement among the Jx packages the system depends on. Install a current Node from [nodejs.org](https://nodejs.org/), or run the CLI with Bun 1.4 or newer: `bun --bun ./node_modules/.bin/docusystem check`. CI always uses Node 24.

## The workflow contract does not match

Exit 3. The reusable workflow exports the integer contract it was written for as `DOCUSYSTEM_WORKFLOW_CONTRACT`, and the installed package implements a different one, so the `uses:` pins and the package have drifted apart across a breaking change. The message names the two `uses:` lines to change. `npx @avunu/docusystem upgrade`, run in `docs-site/`, re-pins both callers to the tag of the installed version; or install the package release that matches the pin.

## Another docusystem process is running

Exit 3, naming the process id. Two builds of one site would write the same `.docusystem/` folder, so a pid file in it (`.docusystem/lock`) lets only one run. A lock whose process is gone is replaced automatically. A running `docusystem dev` holds the lock only while it builds.

## `init` cannot resolve the workflow commit

`init` and `upgrade` pin the workflows to the commit of the tag `v<installed version>`, read with `git ls-remote`. When that fails (offline, or the tag does not exist on GitHub) they exit 1 and name `--workflow-sha`. Pass the 40-character commit yourself: `npx @avunu/docusystem init --workflow-sha <COMMIT_SHA>`. They never fall back to a tag, because a tag can move.

## `init` refuses to write a file

`init` never overwrites what it would have to guess about:

- A workflow that differs from its scaffold, including a copy of the earlier starter's long workflow.
- A `package.json` with a `postinstall` script, or with a dependency on any `@jxsuite/*` package. That is a copy of the earlier starter, and the new shell has neither.

Read what is there, then pass `--force` to let `init` replace it. `--dry-run` shows the diff first.

## "K document problem(s) above fail the build"

```text
docusystem: 3 document problem(s) above fail the build. Fix the documents, or run with --lenient while you work through them.
```

The strict build (`CI=true`, and always `check`) collects every document problem before it stops: lint errors, Jx output lines that start with `Content`, `Warning:` or `Error`, and skipped symbolic links. They are printed once, above this line, with `file:line` where there is one, and nothing is published. Fix them in the Markdown. While you work through a long list locally, `docusystem build --lenient` prints the same problems as warnings and still builds. CI has no lenient setting.

Problems that are never downgraded, even by `--lenient`: a config error, a failing `jx`, a failed output assertion and the contrast gate. A lenient build can therefore print warnings and still fail on an assertion. The `assert:` line names the page and its Markdown file, and the closing lines say that leniency does not reach it: if a `lint:` warning above is about the same file, that warning is the cause (see [an empty link](#an-empty-link-fails-the-build)).

## A link is plain text on the page

The build named the link. Its target does not exist, is a draft, or is not in the repository. Links to repository files outside `docs/` are rewritten to GitHub links, so this is a typo or a draft. The build prints the file and target, and with `links: "error"` (strict) Jx itself exits non-zero and lists every broken link.

## Reference-style links or footnotes are an error

The `lint:` stage reports them as errors with `file:line`: "Reference-style links are not rendered: every link that uses this definition loses its text. Write the links inline" and "Footnotes are not rendered: the marker and the note both disappear". The site cannot show them and would lose text. Write the links inline, `[text](url)`, and put a footnote in the sentence or in a callout. See [what does not render](writing-docs.md#what-does-not-render). `docusystem lint` runs just these checks.

## An empty link fails the build

The `assert:` stage prints `FAIL` for the assertion that no page has an empty link (an `<a href>` with no text, image or `aria-label`). Jx writes an empty link followed by the text (or the image) for a raw HTML anchor in a paragraph, and the assertion fails in every mode, including `--lenient`. The `lint:` stage reports the anchor first, with `file:line` (an error, printed as a warning under `--lenient`), and `docusystem lint` lists it without building. Replace the raw anchor with a Markdown link, `[text](url)`. Badges are `[![alt](image)](url)`.

## A symbolic link is not published

```text
stage: docs/x.md is a symbolic link outside the repository: not published
```

A symbolic link in `docs/`, `overrides/` or `public/` is followed only when its real path is inside the repository and not inside `.git/`, `node_modules/`, or the site's own `.docusystem/` and `dist/`. Anything else is skipped and reported, and under strict a skipped link is an error. Copy the file in, or move it into the repository. Nothing the build writes is a symbolic link.

## Jx dropped routes

The build parses `Done: N routes` from Jx and expects the number of pages plus the static pages (normally two: the landing page and 404). A smaller number means Jx left pages out and is reported as a problem. Look for a file name that produces an address Jx and the sidebar disagree on: rename it to plain letters, digits, spaces and hyphens. Two files with one address (`docs/guides.md` beside `docs/guides/README.md`) are also reported, and only the README is published.

## The slug is not the catalog's spelling

`preflight` compares `slug` with the bundled catalog. A key spelled differently from a catalog key (`erpnext-taskview` for `erpnext_taskview`) is an error, because the project switcher would never mark the project as the current one. The slug keeps the catalog's underscores; the domain uses hyphens. A slug that is not in the catalog at all is only a warning: the project is not in avunu.net's catalog yet.

## A Bun lockfile

`docusystem doctor` reports a `bun.lock` or `bun.lockb` in the site folder as an error, and the reusable workflow refuses it. The shared workflow installs with npm so that Dependabot can read the lockfile and so that the provenance of `@avunu/docusystem` can be verified. Run `npm install` in the site folder, commit `package-lock.json` and delete `bun.lock`. You can still run the CLI under Bun locally.

## Sharp fails to load on NixOS

```text
Sharp is required for image optimization but failed to load
```

The native `sharp` module cannot find the C++ library (`libstdc++.so.6`) as soon as `docs/` contains an image. Either turn off raster-image optimization with `"images": "off"` in `docusystem.config.json`, which needs no native module, or provide the library for the command:

```bash
LD_LIBRARY_PATH="$(nix eval --raw nixpkgs#stdenv.cc.cc.lib.outPath)/lib" npm run build
```

The build prints the `images: "off"` hint itself when Jx's output mentions `sharp` or `libstdc++`. Ubuntu CI is not affected.

## `dev` says the port is in use

`docusystem dev` binds only to `127.0.0.1`. Pass another port: `npm run dev -- --port 3417`. It exits 1 when the first build fails or the port is busy.

## Hooks rewrite `docs/`

A pre-commit hook that stamps a copyright comment above the front matter does not break the build, because staging moves the comment, but GitHub and Obsidian then show the front matter as text. Exclude `^docs/` from that hook. `docusystem doctor` warns about a `.pre-commit-config.yaml` with a copyright hook and mentions formatter configs that would reformat `docs/`. The site folder itself needs no exclusions: it holds only the config, `package.json` and the lockfile.

## A leftover from the starter

`preflight` warns when the site folder contains `components/`, `layouts/`, `pages/`, `project.json` or `scripts/`, which are leftovers of an earlier copy-the-template starter. Delete them: the package supplies all of them. If you want to change one, use [an override](overrides.md).

## Looking inside a build

When something is wrong and the message is not enough, the build keeps everything it did:

- `docs-site/.docusystem/manifest.json` records the package and Jx versions, where each file of the assembled root came from, shadowed and added files, the catalog source and whether the build was strict.
- `docs-site/.docusystem/jx.log` is the raw output of the last Jx run.
- `docs-site/.docusystem/site/` is the assembled Jx project, with the staged Markdown in `.generated/docs/` and the sidebar in `.generated/nav.json`.
- `npx @avunu/docusystem info`, run in `docs-site/`, prints versions, folders, the resolved branch, overrides and the exact command to run Jx by hand; `--json` and `--nav` print it as JSON and the sidebar tree.
- When Jx fails, the build prints `docusystem: jx build failed. The assembled project is <root>; run: <execPath> <jx.js> build <root>`.

To see what Jx itself prints for the assembled root, run it through the pinned Jx, in `docs-site/`:

```bash
cd docs-site
npx @avunu/docusystem jx build --verbose
```

From the repository root, run the installed copy instead: `./docs-site/node_modules/.bin/docusystem jx build --verbose` finds `./docs-site` on its own, and `--site <folder>` names another site folder.

`docusystem jx` assembles the project root (docusystem itself builds nothing), then runs the pinned Jx CLI as `jx <arguments> <root>`. Everything after `jx` goes to Jx unchanged, so give `--site` before it. It exits with Jx's exit code. The root is assembled from empty on every run, so what Jx writes into it lasts only until the next docusystem command, and `jx build` writes to `<root>/dist`, not to `<site>/dist`, and skips the post-build steps.

> [!WARNING]
> `jx validate` does not work on the generated root, so `docusystem jx validate` is not a check to run. It fails with `project.schema.json not found` and tells you to run `jx schema`, and `docusystem jx schema` cannot help: the next `docusystem jx` run assembles the root again and the schema is gone. Run by hand after `jx schema`, Jx's validator reports the package's own pages and layouts as invalid, because its schema for a `Function` entry has no `timing` key and the package's pages use `timing: "compiler"`, which Jx's compiler accepts. Nothing in that report is yours to fix. Use `docusystem check` for the checks that apply to a site.

> [!NOTE]
> Jx Studio and `jx dev` are not supported on the assembled root. The Markdown lives outside the Jx project root, `jx dev` needs the optional `@jxsuite/server` package and Bun, and it skips the post-build fixes. `docusystem dev` serves exactly what deploys.

In CI, a failed run uploads the manifest, the Jx log and the assembled project as the artifact `docusystem-debug`. Download it, and read `manifest.json` and `jx.log` first.
