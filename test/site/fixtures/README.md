---
title: Fixtures of the site tests
description: What the files in test/site/fixtures are, where they came from and how to change them.
---

These are input files of `test/site/**`. They are files, not tests, and the formatter and the linter
leave them alone.

| File | What it is | Used by |
| --- | --- | --- |
| `docs/**` | A small documentation tree that stands in for a project's `docs/` folder: a home page, a loose page, folders with a `README.md`, `readme.md` and `index.md`, a file name with capitals and a space, all five alert kinds, a table, a code fence, a page with two level-one headings, and the files that must NOT be published (`_private.md`, `_partials/`, `.hidden/`, `draft.md` with `draft: true`, `unpublished.md` with `publish: false`). | `build.test.ts`, `rules.test.ts` |
| `nav.json` | The sidebar data (`.generated/nav.json`) that the navigation code of the prototype produced for `docs/**` with the site name `Example Project`. It is what `nav.ts` (WP3) writes in a real build; `rules.test.ts` compares WP3's `buildNav` with it as soon as that code exists. | `build.test.ts`, `rules.test.ts` |
| `starter-1820d01.json` | The sha256 of every file of the starter template (`Sites/project-docs-starter/template/` of Avunu/docs at commit `1820d01`, the commit the three pilots copied): components, layouts, pages, public files and `project.json`. | `starter.test.ts` |
| `surface.json` | The part of `site/` that is semver surface (section 7.1): design-token names, component tags, media-query names and the file list. | `surface.test.ts` |

## Changing them

- **`docs/**`**: if you add, remove or rename a file, update `DOC_FIXTURES` in `support/fixtures.ts` (the
  route of each file, or why it is left out) and regenerate `nav.json`, otherwise `rules.test.ts` and
  `build.test.ts` fail.
- **`nav.json`**: regenerate it from the Markdown with `writeNav` of WP3 (`src/lib/nav.ts`) for the site
  name `Example Project`; it is written as JSON with two-space indentation and a trailing newline.
- **`starter-1820d01.json`** is a record of the past and never changes.
- **`surface.json`**: removing or renaming a token, a tag or a file under
  `site/{components,layouts,pages,public}` is a MAJOR change of the package; adding one is a MINOR change.
  Either way the list is edited in the same commit as the change, so that the surface never moves by
  accident.
