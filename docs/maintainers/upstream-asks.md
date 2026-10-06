---
title: Upstream asks of Jx
description: The changes this system asks of Jx, why each is needed, the workaround that stands in for it today, and the code that each one would let this package delete.
nav_title: Upstream asks
order: 1
updated: 2026-10-06
tags: [maintainers, jx, upstream]
---

Much of this package exists because Jx 5.0.0 has no project-level composition. Jx is Avunu's own framework, so each ask below is realistic. When one lands, the named code is deleted from this package and the shells of consuming projects do not change.

The asks were verified against the Jx packages this version pins: compiler 5.0.0, parser 2.0.0, runtime 4.0.3 and search 0.4.0.

## What Jx does today

These facts shape the design:

- Jx reads `pages/`, `components/*.json` (flat), `public/` and the `$layout` chain only from the project root, and a nested `$layout` is resolved against that root.
- `$elements` with a `$ref` cannot register components that come from a package.
- `project.json` has no `extends`.
- `copy` takes files only.
- A directory symlink as `public/` fails the build.
- The development watcher sees only what is inside the root.
- Unknown keys and unregistered components are silently ignored: an empty custom element is emitted and the build still exits 0.
- An extension's `emit` cannot modify or delete files that Jx already wrote, and it runs only for a non-empty section.
- Jx reads `components/` in raw directory order, so the order of component styles and module preloads in the output follows the file system.

The package works around them by assembling a plain Jx root from real copies (see [Build pipeline](../reference/build-pipeline.md)), and by asserting the output positively because Jx will not complain.

## The asks

| Ask                                                                                                                                         | What it would delete here                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `project.json` `extends`, or presets                                                                                                        | The base merge in `project.ts` and the merge rules of the `jx` config fragment     |
| Components, pages and layouts supplied by a package (bare or `npm:` specifiers, a file-relative nested `$layout`, extra search directories) | Copying `site/` into the root, and the generated root itself                       |
| `copy` of directories, symlink dereference, and a directory-symlinked `public/`                                                             | The copy of `public/`                                                              |
| Watching `content.source` outside the root                                                                                                  | `devserver.ts`: `jx dev` could be used instead                                     |
| A sorted directory read of `components/`                                                                                                    | The order-normalizing comparison in the tests, and the byte-reproducibility caveat |
| An extension `emit` that can modify or delete written files, and consistent `head` gating for empty sections                                | Nothing today; it makes the Jx-extension route viable                              |
| Computing the navigation inside Jx from the loaded collection                                                                               | `docs.ts`, `nav.ts` and their copy of Jx's route rules                             |
| A correct error for package subpaths that are not exported                                                                                  | Nothing                                                                            |

### Composition: `extends` and packages

The two largest asks. With `extends` (or presets), the package would ship its project settings and each shell would extend them, and the generated `project.json` and the `jx` merge rules would go. With components, pages and layouts loadable from a package, the package would ship them in `node_modules` and the shell's project root could be the shell itself: the copying of `site/` and the generated root would go.

### Directories and symlinks in `copy` and `public/`

`copy` takes individual files, and a directory symlinked as `public/` fails the build. The package therefore copies `public/` file by file, and real copies behave the same on every file system and installer.

### Watching outside the root

The Markdown lives in the repository's `docs/`, outside any Jx root the package could assemble. The Jx dev watcher sees only inside the root, so `docusystem dev` carries its own watcher and server (`devserver.ts`), and `jx dev`, which also needs `@jxsuite/server` and Bun, is not supported. If Jx watched `content.source` outside the root, the dev server could be deleted.

### A sorted read of `components/`

Jx reads `components/` in raw directory order. The component styles and module preloads in the output therefore appear in the order the file system returns, so comparing two builds needs a normalizing step and byte-for-byte reproducibility is not promised. A sorted read would remove both.

### Extensions

An extension's `emit` cannot change or delete files Jx already wrote and runs only when its section is non-empty, so a Jx extension cannot yet do what the post-build step does (move `404/index.html`, drop the per-page Markdown copies, fix canonical addresses). Allowing `emit` to modify and delete, and gating `head` consistently for empty sections, would make an extension a viable replacement for part of `postbuild.ts`.

### Navigation inside Jx

The sidebar, previous and next links and the landing cards are computed by this package from the staged Markdown, and the package re-implements Jx's route, `exclude` and `where` rules to do it. A test asserts that the two agree, and the link crawl is the safety net. Data availability for computing the navigation inside Jx, with a `$prototype` class that reads the loaded collection, was checked but not ported. Doing it there would remove the duplicate rules.

### Errors for package subpaths

The ask is that Jx report a package subpath that is not exported with an error that says so. It deletes nothing here.

## Filing them

Each ask belongs in an issue on [`jxsuite/jx`](https://github.com/jxsuite/jx/issues) that links to this page and names the version it was verified against. Whether and when to file them is a decision for Avunu, tracked in [MAINTAINING.md](../../MAINTAINING.md#open-decisions).
