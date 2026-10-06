---
title: Upgrading
description: How a documentation site takes a new release of the package, what each kind of release can change, and how to check the result.
order: 5
updated: 2026-10-06
tags: [guide, upgrading, dependabot]
---

A documentation site lists one dependency, `@avunu/docusystem`, and the package pins the exact Jx packages it was tested with. Upgrading is therefore a small, reviewable change.

## The normal path

Dependabot does the work, through the two entries `init` added:

1. A new release of the package arrives as one grouped npm pull request: the range in `docs-site/package.json` and the lockfile.
2. A new commit pin of the shared workflows arrives as one `github-actions` pull request that moves both `uses:` lines of both callers.
3. Each pull request runs `docs.yml` and uploads the built site as an artifact, so you can look at what would be published.
4. A person merges. The merge publishes the site.

The two pull requests can merge in either order. Within one workflow contract (see [versioning](../reference/versioning.md#workflow-contract)) a workflow pin and a package version may differ in minor and patch freely.

## The manual path

```bash
cd docs-site
npm update @avunu/docusystem
npx @avunu/docusystem upgrade
npm run check
```

`upgrade` re-pins both `uses:` lines of both callers to the commit of the tag `v<installed version>`, adds any missing Dependabot entries, and prints what it changed. It removes nothing else and never touches overrides or the config. Use `--dry-run` to see the changes first, and `--workflow-sha <sha>` when the commit cannot be resolved with `git ls-remote`.

## After any upgrade

Run `docusystem doctor`. It reports stale pins, drifted overrides and everything else in the [doctor checks](../reference/doctor.md).

If the CLI exits 3 with a message about the workflow contract, the `uses:` pin and the installed package have drifted apart across a contract change. `docusystem upgrade` fixes the pin; the message names the lines.

## What a release can change

The package follows [Semantic Versioning](https://semver.org), driven by Conventional Commits. The semver surface is exactly the list in [versioning](../reference/versioning.md#the-semver-surface). In short:

| Release | May change                                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Major   | A removed or renamed command, option or config key; a changed exit code; a removed or renamed design token, component file or tag; a changed page URL scheme; a Markdown convention that stops working; a changed workflow input, permission or job name; a higher Node floor |
| Minor   | New commands, options, optional config keys, components, layouts and tokens; a Jx upgrade that authors and readers cannot see; visual refinements that keep every token, URL and region                                                                                       |
| Patch   | Fixes, dependency bumps (including Jx) that change nothing above, catalog refreshes                                                                                                                                                                                           |

Before 1.0, a minor release may break anything except the workflow-contract rule. Callers pin the exact commit anyway, so nothing changes until a pull request is merged.

A breaking release carries a `BREAKING CHANGE:` note with the exact edit to make. A renamed config key keeps working for one minor with a warning, and the note says what to change; removal happens only in a major.

## Overrides and upgrades

Overrides and the `jx` fragment are outside semver. After an upgrade, `doctor` lists every ejected file whose package original changed. Decide for each whether to take the package's new file or keep yours; see [Customizing](overrides.md#rung-3-replacing-a-file).

## Jx

Jx updates reach your site as ordinary package releases. Dependabot in `Avunu/docusystem` proposes a Jx update, the full test and example build run against it, a person merges, and the next patch release of this package reaches your site's Dependabot. A consumer's own `@jxsuite/*` packages, if any, are ignored: the CLI links the ones it was installed with. `init` refuses an existing `package.json` that depends on any `@jxsuite/*` package unless you pass `--force`, because that usually means a copy of the earlier starter.
