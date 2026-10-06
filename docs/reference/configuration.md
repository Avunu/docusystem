---
title: Configuration
description: Every key of docusystem.config.json, what is required, how the branch is resolved, and the rules for theme, images and the jx fragment.
order: 1
updated: 2026-10-06
tags: [reference, config, schema]
---

A project's site is configured by one file, `docs-site/docusystem.config.json`. `init` writes it and the build requires it. A build never guesses a missing key.

```json
{
  "$schema": "./node_modules/@avunu/docusystem/config.schema.json",
  "name": "Example Project",
  "tagline": "A sample project that shows what a documentation site made of Markdown and a few small files looks like.",
  "slug": "docusystem-example",
  "platform": "general",
  "repo": "https://github.com/Avunu/docusystem-example",
  "domain": "docusystem-example.avunu.net",
  "license": "MIT"
}
```

The `$schema` line gives an editor completion and validation from the JSON Schema the package exports as `@avunu/docusystem/config.schema.json` (draft 2020-12).

## Required keys

The seven identity keys are required and are the only facts about a project that the system needs. Each is written once; the project name, URL, `CNAME`, package name, edit link, switcher slug and default branch are derived from them, never copied into other files.

| Key        | Type and limits                                     | Meaning                                                                                                                             |
| ---------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | String, 1 to 80 characters                          | Display name: the header, page titles and the footer.                                                                               |
| `tagline`  | String, 1 to 200 characters                         | One sentence on the landing page and the default page description. The placeholder tagline written by older tools is refused.       |
| `slug`     | `^[a-z0-9][a-z0-9_-]*$`                             | The project's key in avunu.net's `projects.json` catalog. It may contain underscores and marks the current project in the switcher. |
| `platform` | `frappe`, `odoo`, `wordpress`, `nixos` or `general` | Groups the project in the switcher and sets the eyebrow on the landing page.                                                        |
| `repo`     | `https://github.com/<owner>/<repo>`                 | The header's GitHub link, "Edit this page" and the rewritten links to repository files.                                             |
| `domain`   | A host name without a scheme                        | The custom domain. Normally the repository name with hyphens, then `.avunu.net`.                                                    |
| `license`  | String, 1 to 80 characters                          | An SPDX license identifier, shown on the landing page and in the footer.                                                            |

The text keys `name`, `tagline` and `license`, and `docs`, must not contain `${`: Jx evaluates a string that holds one as JavaScript when the site is built, and these reach every page. Validation refuses them before anything is built.

The slug keeps the catalog's spelling, including underscores (`erpnext_taskview`), while the domain uses hyphens (`erpnext-taskview.avunu.net`). The domain is not always the repository name: the repository `cloudflare-email-relay` is served at `cloudflare-email.avunu.net`, which `init` takes as `--domain cloudflare-email.avunu.net`. A slug spelled differently from a catalog key is an error; a slug that is not in the bundled catalog is a warning.

## Optional keys

| Key      | Default             | Meaning                                                                                                                                                              |
| -------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branch` | Resolved, see below | The default branch used by "Edit this page" and the GitHub links. Normally absent.                                                                                   |
| `docs`   | `../docs`           | The folder of Markdown, relative to the config file. It must lie inside the repository, or the build exits 1: files from outside the repository are never published. |
| `theme`  | None                | Design-token overrides: `theme.light` and `theme.dark`, each an object of token name to CSS value.                                                                   |
| `images` | `"optimize"`        | `"off"` skips raster-image optimization and so the native `sharp` module.                                                                                            |
| `jx`     | None                | An unsupported escape hatch merged into the generated Jx `project.json`.                                                                                             |

`README.md`, `readme.md` or `index.md` in the docs folder is the home page (`/docs/`).

### Reserved keys

`switcher`, `footer`, `logo`, `ogImage`, `landing`, `editLink`, `lang`, `nav` and `updated` are reserved for later minor releases. Today they are rejected like any other unknown key. Adding an optional key is a minor release.

## Validation

`validateConfig` returns every problem as a sentence, all at once. An unknown key is an error with a suggestion:

```text
"tagLine" is not a docusystem setting; did you mean "tagline"?
```

The schema is the editor contract, and `validateConfig` enforces at least everything the schema does.

## The branch

The branch feeds "Edit this page" and the GitHub blob, tree and raw links. It is resolved in this order:

1. The config's `branch`.
2. `$DOCUSYSTEM_BRANCH` (set by the reusable workflow to the repository's default branch), if it is a valid branch name.
3. `git symbolic-ref --short refs/remotes/origin/HEAD`, minus the `origin/` prefix.
4. `main`.

`init` writes `branch` only when you pass `--branch`. The workflows never need it, because they read the repository's default branch themselves.

## Theme

```json
{
  "theme": {
    "light": { "--color-action": "#4B2A99" },
    "dark": { "--color-action": "#CBB8FF" }
  }
}
```

- Each token name must exist in the installed package's `site/project.base.json`: `style` keys that start with `--` for `light`, keys of `style["@--dark"]` for `dark`. Otherwise the build reports an error naming the token.
- Values are plain CSS. The schema pattern forbids `;`, braces, angle brackets and backslashes, and `validateConfig` additionally refuses `url(` and `@import`. A value is at most 200 characters.
- `docusystem check` re-runs the WCAG contrast pairs on the resolved tokens and fails below the minimum.

## Images

`"images": "off"` generates `project.images = {"optimize": false}`: no raster-image optimization and no native `sharp` module. Use it where `sharp` cannot load, such as NixOS.

## The `jx` fragment

`jx` is merged into the generated `project.json` after the theme. It is outside semver. The rules:

- Objects merge key by key.
- `null` deletes a key.
- The array at `$head` is appended to the package's, package entries first.
- Every other array replaces the package's and prints `overrides: jx.<path> replaces N entries of the package's list`; that warning is listed in the manifest.
- `name`, `url` and `content.docs.source` cannot be overridden without a warning that says so.

```json
{
  "jx": {
    "$head": [
      {
        "tagName": "meta",
        "attributes": { "name": "google-site-verification", "content": "TOKEN-FROM-SEARCH-CONSOLE" }
      }
    ]
  }
}
```

The `$head` entries are the site-wide level of every page's `<head>`. Jx builds each page's head from three levels in turn, the site (`project.json`, where the fragment goes), the layout and the page, and an entry replaces an earlier one with the same key: a `meta` is identified by its `name` or `property`, a `link` by its `rel` and `href`, a `script` by its `src`. A fragment entry therefore replaces the package's own site-level entries of the same key (`generator`, for example), but not what the layout or a page sets. The package's base layout sets `description`, `robots`, `og:type`, `og:title`, `og:description`, `twitter:card`, `twitter:title` and `twitter:description`; the 404 page sets `robots` to `noindex, nofollow`. A fragment entry for one of those builds and passes `check`, and the layout's tag is the one in the page. Use the fragment for tags the package does not set, such as the search-engine verification above or an extra `link`.

The build lists the fragment with the overrides: the `overrides:` line printed while the root is assembled, the closing `build: overrides:` line, `docusystem info` and the CI job summary all name it, and `docusystem doctor` warns that it does not follow package updates.

## The resolved config

The build writes the resolved configuration into the generated project root as `docusystem.config.json` with the keys `name`, `tagline`, `slug`, `platform`, `repo`, `domain`, `license`, `branch` and `docsPath` (the Markdown folder relative to the repository root, `/`-separated). Layouts and pages read it through the Jx content type `config`. See [build pipeline](build-pipeline.md#the-generated-project-root).

## Programmatic use

Package code can read the same file through the package's exports: `readConfig(siteDir)` and `validateConfig(raw)`, with the `DocsConfig` type. See [versioning](versioning.md#package-exports).
