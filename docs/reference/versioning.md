---
title: Versioning and compatibility
description: What counts as a breaking change, how Jx is pinned, the workflow contract, supported runtimes, the 1.0 criteria and the package exports.
order: 6
updated: 2026-10-06
tags: [reference, semver, compatibility]
---

The package follows [Semantic Versioning](https://semver.org), driven by [Conventional Commits](https://www.conventionalcommits.org) and release-please. This page is the policy.

## The semver surface

**Major** changes:

- A removed or renamed CLI command or option; a changed exit code.
- A removed or renamed config key, a newly required one, or a changed meaning of a key.
- The removal or rename of a design-token name.
- The removal or rename of a file under `site/{components,layouts,pages,public}`, or of a custom-element tag (`docs-*`, `project-switcher`, `theme-toggle`).
- A changed page URL scheme (`/` for the landing page, `/docs/<slug>/`, `404.html`), a changed shape of `search-index.json`, or a changed sitemap structure.
- A Markdown convention that stops working: GitHub alerts, relative `.md` links, repository-link rewriting, or the front-matter keys `title`, `description`, `nav_title`, `order`, `hidden`, `draft`, `publish`, `updated` and `tags`.
- A changed input, permission or job name of a reusable workflow, or a change that needs a different caller. Job names become required-check names.
- A higher Node floor.
- Any change to the programmatic exports.

**Minor** changes: new commands, options, optional config keys, components, layouts and tokens; a Jx upgrade invisible to authors and readers; visual refinements that keep every token, URL and region.

**Patch** changes: fixes; dependency bumps, including Jx, that change nothing above; catalog refreshes.

**Outside semver:** the contents of any `site/` file; everything under `overrides/`; the `jx` fragment; `manifest.json`, `jx.log` and human-readable output; the mechanics of the workflow contract.

A Jx major upgrade is a minor or patch of this package unless it changes something in the major list.

## Jx

The package pins every Jx package it was tested with, exactly: `@jxsuite/compiler`, `@jxsuite/parser`, `@jxsuite/runtime` and `@jxsuite/search`. A published package ignores its own lockfile, so exact pins are how the tested set reaches consumers. A shell lists no Jx package, and a consumer's own `@jxsuite/*` packages are ignored, because the CLI links the ones it was installed with into the assembled root. `@jxsuite/server` is not a dependency.

A Jx release reaches a site in this order:

1. Dependabot in `Avunu/docusystem` opens a pull request (group `jx`, `fix(deps)`).
2. The whole CI run, including a canary that builds a real tree with the real Jx and checks that strictness still fails, the consumer matrix and the browser suites.
3. A person merges it, and release-please proposes a patch release.
4. The fleet job runs on the release pull request, the release is published, and each site's Dependabot opens its grouped pull request.

A scheduled job also installs the latest Jx over the pins and runs the canary and the example build, opening an issue on failure. That is the early warning for a Jx release that Dependabot has not proposed yet.

## Workflow contract

`WORKFLOW_CONTRACT` is an integer constant in the package and the literal `DOCUSYSTEM_WORKFLOW_CONTRACT: "1"` in `docs-build.yml`; a test asserts they are equal. It starts at 1 and changes only when the workflows and the CLI stop being able to work together: the command line the workflow runs, the environment it sets, or the output path `<site>/dist`. A change requires a package major (a minor before 1.0) and a changelog note, and `docusystem upgrade` re-pins the callers. The CLI exits 3 on a mismatch and names the `uses:` line.

Within one contract a workflow pin and a package version may differ in minor and patch freely, so Dependabot's npm and `github-actions` pull requests need not merge together.

## Runtime support

| Runtime                                        | `build`, `check`, `dev`                            | CI                                                  | Notes                                                                                 |
| ---------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Node 22.19.0 or newer; tested on 22, 24 and 26 | Yes                                                | Node 24 only                                        | The floor is derived from the Jx packages' own requirements                           |
| Bun 1.4 or newer (tested on 1.4.2)             | Yes, as `bun --bun ./node_modules/.bin/docusystem` | Not used                                            | Bun's bundler changes the minified bytes of three vendored assets; harmless           |
| Linux and macOS                                | Yes                                                | Ubuntu, plus two macOS rows in the package's own CI |                                                                                       |
| Windows                                        | Unsupported                                        |                                                     | Junction links and path separators are untested                                       |
| npm hoisted; Bun hoisted; Bun isolated         | Yes                                                | Rows in the package's matrix                        | `npm --install-strategy=linked` fails on esbuild's platform binary and is unsupported |

CI and deployments use Node 24 only, so deployed bytes never depend on a local Bun. The shared workflow installs with npm and `package-lock.json` only: Dependabot cannot update the lockfile version that Bun 1.4 writes, and the Bun path skips signature and provenance verification.

## Before and after 1.0

Before 1.0.0 a minor release may break anything except the workflow-contract rule above; callers pin the exact commit anyway. Release 1.0.0 happens only when:

- the three pilot repositories (`frappe-nix`, `erpnext_taskview` and `cloudflare-email-relay`) are deployed on a released version;
- one Dependabot-authored upgrade pull request has run its checks on GitHub;
- the fleet job is green on every repository in it;
- the first provenance-signed release exists;
- the GitHub-side behaviors listed in [MAINTAINING.md](../../MAINTAINING.md) are confirmed.

## Package exports

The package's `exports` are:

```json
{
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./config.schema.json": "./config.schema.json",
  "./package.json": "./package.json"
}
```

The `.` entry exports exactly `PLATFORMS`, the types `Platform` and `DocsConfig`, `readConfig(siteDir)`, `validateConfig(raw)`, `name`, `version` and `WORKFLOW_CONTRACT`. Nothing else is importable. The package's `site/` and `scaffold/` folders are read by path inside the package and are internal; a shell depends on their file names only through `eject`.
