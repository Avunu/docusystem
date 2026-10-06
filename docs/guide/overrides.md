---
title: Customizing
description: The ladder from config values to replaced files, what each rung costs in upgrades, and how to use theme tokens, static files, eject and the jx fragment.
nav_title: Customizing
order: 4
updated: 2026-10-06
tags: [guide, theme, overrides]
---

Every Avunu documentation site looks the same on purpose. When a project needs something different, use the cheapest rung of the ladder that works. Each rung below the first costs a little of the project's ability to follow package updates, and the system makes that cost visible instead of hiding it.

## The ladder

| Rung | Mechanism                                                                            | Follows package updates              | Guard rails                                                                         | Semver                                        |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| 0    | The seven identity keys, and the optional `branch`, `docs` and `images`              | Yes                                  | Schema, `validateConfig`, preflight                                                 | Covered                                       |
| 1    | `theme.light` and `theme.dark` token overrides in the config                         | Yes (token names are semver surface) | An unknown token is an error; `check` re-runs the WCAG contrast pairs on the result | Covered                                       |
| 2    | Files in `docs-site/public/`: favicon, logo, og image, other static files            | Yes                                  | Each shadowed package file is printed and recorded; `CNAME` may not be supplied     | Covered                                       |
| 3    | Files in `docs-site/overrides/{components,layouts,pages}/`: replace or add a Jx file | No, for replaced files               | Printed on every build and recorded in the manifest; `doctor` reports drift         | Not covered: file names are, contents are not |
| 4    | A `jx` fragment in the config                                                        | No                                   | Merge warnings are printed and recorded                                             | Not covered                                   |
| 5    | A change to `site/` in `Avunu/docusystem`, by pull request                           | Yes, for everyone                    | Review and the fleet job                                                            | Covered                                       |

Rung 5 is the right answer when the change would help other projects too. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Rung 1: theme tokens

Override design tokens by custom-property name, for the light scheme, the dark scheme or both:

```json
{
  "theme": {
    "light": { "--color-action": "#4B2A99" },
    "dark": { "--color-action": "#CBB8FF" }
  }
}
```

- Each token name must exist in the installed package. The tokens are the `style` keys that start with `--` in `site/project.base.json` inside the package (for `light`) and the keys of its `style["@--dark"]` object (for `dark`). An unknown name is an error that names it.
- Values are plain CSS. The schema forbids `;`, braces, angle brackets and backslashes, and `validateConfig` also refuses `url(` and `@import`.
- `docusystem check` resolves the effective tokens and runs the WCAG contrast pairs on the result. A value that drops a pair below its minimum fails the check: for example `#C9B8FF` as a light-scheme `--color-action` fails at 1.78:1, while `#4B2A99` passes. Contrast failures are never downgraded, not even by `--lenient`.

The package's other design rules (one `style` object with `@--dark` overrides, light and dark by `prefers-color-scheme` and the `data-color-scheme` toggle contract, the 46rem prose measure, components prefixed `docs-`) are internal. Only token names and file and tag names are covered by semver.

## Rung 2: static files

Put a file in `docs-site/public/` and it is published at the same path. Package files of the same name lose, and each one that is shadowed is printed on every build and recorded in the manifest.

```text
docs-site/
  public/
    favicon.svg
    brand/logo.svg
    og.png
```

`CNAME` is generated from `domain` and may not be supplied: a `public/CNAME` is an error. Symbolic links are followed only inside the repository (see the [symlink policy](../reference/command-line.md#symlink-policy)).

## Rung 3: replacing a file

Put a Jx file at the same relative path in `docs-site/overrides/components/`, `layouts/` or `pages/` and it replaces the package's file. A path the package does not ship is an addition: a new page or layout is allowed.

The safe way to start is `eject`, which copies the package's current file into `overrides/` and records where it came from:

```bash
npx docusystem eject components/docs-footer.json
npx docusystem eject --all
```

`eject` takes one or more `components/<file>`, `layouts/<file>` or `pages/<file>` arguments, or `--all`. It exits 1 for an unknown file or when an override already exists; `--force` overwrites. It records each file in `overrides/.ejected.json`:

```json
{
  "components/docs-footer.json": { "from": "0.1.0", "sha256": "<SHA256_OF_THE_PACKAGE_FILE>" }
}
```

Rules:

- **Precedence**, lowest to highest: the package's `site/`, then `overrides/`, then the generated files (`project.json`, `docusystem.config.json`, `CNAME`, the data files and the staged docs). Within `public/`: the package's, then yours, then `CNAME`.
- **Granularity is the file name.** An override replaces the package file of the same relative path as a whole.
- **Components are flat.** Jx registers only `<root>/components/*.json`, so `overrides/components/` must be flat: a nested file is an error. A new component that should also be a Markdown directive needs the `content.docs.$elements` list restated through the `jx` fragment (an array, so it replaces the package's list and prints the warning below). That path has not been exercised yet.
- **Overrides are visible.** Every override and addition is printed on every build, recorded in `.docusystem/manifest.json` (`files`, `shadowed`, `added`) and outside semver.
- **Drift is reported.** `docusystem doctor` compares each ejected file with the installed package: `current`, `changed` (the package's file changed since the eject: "copied from 0.1.0, package file changed"), `stale` (the package no longer ships the file, an error) or `not ejected` (an override of a package file made by hand, which cannot be drift-checked). To take the package's newer file, move your override aside, run `eject` again, and re-apply your changes to the fresh copy.

> [!WARNING]
> An overridden file no longer follows package updates. A design change, a new token or an accessibility fix in the package's version of that file does not reach your site until you merge it yourself.

## Rung 4: the `jx` fragment

The config's `jx` object is merged into the generated Jx `project.json` after the theme. It is an unsupported escape hatch, outside semver:

```json
{
  "jx": {
    "$head": [{ "tagName": "meta", "attributes": { "name": "robots", "content": "noindex" } }]
  }
}
```

The merge rules:

- Objects merge key by key.
- `null` deletes a key.
- The array at `$head` is appended to the package's, package entries first.
- Every other array replaces the package's, and the build prints `overrides: jx.<path> replaces N entries of the package's list`. That is a warning, and it is listed in the manifest.
- The fragment cannot override `name`, `url` or `content.docs.source` without a warning that says so.

## Not possible on purpose

A different design language (fork the package or make a new one), a per-project structure of the shared header and footer, per-project build scripts or post-build steps, a different route scheme and a different font set. These would make the sites diverge, which is what the system exists to prevent.

## Images

`images` defaults to `"optimize"`, which keeps WebP and AVIF output and needs the native `sharp` module. Set `"images": "off"` to skip raster-image optimization and `sharp` entirely, for example on NixOS (see [troubleshooting](troubleshooting.md#sharp-fails-to-load-on-nixos)).
