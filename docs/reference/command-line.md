---
title: Command line
description: The eleven docusystem commands with their options, exit codes, environment variables, strictness rules and output conventions.
order: 2
updated: 2026-10-06
tags: [reference, cli, commands]
---

The binary is `docusystem`. Run it from a site folder's `package.json` scripts, with `npx docusystem`, or under Bun as `bun --bun ./node_modules/.bin/docusystem`. It needs Node 22.19.0 or newer, or Bun 1.4 or newer.

```text
docusystem <command> [options]
```

| Command               | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| [`init`](#init)       | Write the shell of a docs site into a repository                 |
| [`build`](#build)     | Build the site into `<site>/dist`                                |
| [`check`](#check)     | What CI runs: a strict build, the contrast gate and a link crawl |
| [`dev`](#dev)         | Serve the site and rebuild when the Markdown changes             |
| [`lint`](#lint)       | Check the Markdown only, as `file:line` messages                 |
| [`links`](#links)     | Crawl an already built site                                      |
| [`info`](#info)       | Show versions, folders, overrides and how to run Jx by hand      |
| [`doctor`](#doctor)   | Check the repository against the maintainer checklist, offline   |
| [`upgrade`](#upgrade) | After an update, re-pin the workflows to the installed version   |
| [`eject`](#eject)     | Copy package files into `overrides/` so that they can be changed |
| [`jx`](#jx)           | Run the pinned Jx CLI on the assembled project, for debugging    |

`docusystem <command> --help` prints the options of one command.

## The site folder

Every command except `init` operates on a site folder, the folder that holds `docusystem.config.json`. It is resolved as:

1. `--site <dir>`, else
2. the current directory if it has the config, else
3. `./docs-site` if it has the config, else
4. exit 1, listing what was searched.

## Global options

| Option            | Effect                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `--site <dir>`    | The site folder (every command except `init`, which takes `--site-dir`)                           |
| `-v`, `--version` | Print the version and exit 0                                                                      |
| `-h`, `--help`    | Print help and exit 0. With no command, help is printed too. After a command, that command's help |

An unknown command or option prints a message and the help on standard error and exits 2. `--strict` together with `--lenient` is a usage error. Options with an empty value (`--name ""`) are a usage error too.

## Commands

### `init`

Writes the shell of a docs site. Run it at the repository root or inside the site folder. It never creates `docs-site/docs-site`; from any other subfolder it exits 1 and says where to run it.

| Option                                                | Meaning                                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--site-dir <dir>`                                    | Site folder, relative to the repository root. Default `docs-site`.                                                           |
| `--name <text>`, `--tagline <text>`, `--license <id>` | Values it cannot infer from the catalog.                                                                                     |
| `--slug <slug>`                                       | The key in the avunu.net catalog; needed when several entries match and none is named like the repository.                   |
| `--platform <platform>`                               | `frappe`, `odoo`, `wordpress`, `nixos` or `general`.                                                                         |
| `--repo <url>`                                        | `https://github.com/<owner>/<name>`. Default: the `origin` remote.                                                           |
| `--domain <domain>`                                   | Default: the slug with `_` written as `-`, plus `.avunu.net`.                                                                |
| `--branch <name>`                                     | Write the default branch into the config. Normally not written.                                                              |
| `--docs <path>`                                       | The Markdown folder, relative to the site folder. Default `../docs`.                                                         |
| `--from-readme`                                       | When `docs/` has no `README.md` or `index.md` (any case), copy the repository's README there. Never overwrites, never moves. |
| `--no-workflow`                                       | Do not write the two caller workflows.                                                                                       |
| `--no-dependabot`                                     | Do not add Dependabot entries.                                                                                               |
| `--no-patch-automerge`                                | Do not patch an existing Dependabot auto-merge workflow.                                                                     |
| `--workflow-sha <sha>`                                | Pin the workflows to this commit instead of resolving the tag of the installed version.                                      |
| `--force`                                             | Overwrite what `init` would refuse to overwrite.                                                                             |
| `--dry-run`                                           | Print every file and diff, write nothing.                                                                                    |

What it does, in order:

1. **Infers** the repository from the `origin` remote, the catalog entry whose `repo` matches (an error asking for `--slug` when several match), then `slug`, `name`, `tagline`, `platform` (else `general`), `license` and `domain`. A value it cannot infer is an error naming the option. Everything inferred is printed under "chosen for you". Existing config values win over inference, so running again never resets a tagline.
2. **Writes** the config; `package.json` when absent (when present it only adds the dependency and the three scripts, and exits 1 without `--force` if the file has a `postinstall` script or depends on any `@jxsuite/*` package; `--force` rewrites `dependencies` to the single package); the `.gitignore` lines; the two caller workflows, with the commit of the tag `v<installed version>` found by `git ls-remote https://github.com/Avunu/docusystem` (the peeled `^{}` line is preferred); the Dependabot entries; and the auto-merge patch.
3. **Refuses** to overwrite an existing workflow that differs from its scaffold unless `--force`. If the commit cannot be resolved (offline, tag missing) it exits 1 and names `--workflow-sha`; it never falls back to a tag.
4. **Prints** "A maintainer still has to:" followed by the settings in [Publishing](../guide/publishing.md), and "Next: cd docs-site && npm install && npm run check".

Exit codes: 0 wrote, or nothing to do; 1 cannot decide a value, refused to overwrite, or could not resolve the workflow commit; 2 usage.

`init` and `upgrade` need `git` on the `PATH`.

### `build`

```text
docusystem build [--strict | --lenient] [--refresh-catalog]
```

Runs steps 1 to 14 of the [build pipeline](build-pipeline.md) and publishes `<site>/dist`. `--strict` and `--lenient` set the [strictness](#strictness). `--refresh-catalog` fetches the live project catalog instead of using the bundled one; it is the only network access a build can make.

Exit 0 ok; 1 problems (strict) or a failure; 3 environment.

### `check`

```text
docusystem check [--ci] [--refresh-catalog]
```

What CI runs: `build` (always strict), then the contrast gate and the link crawl. `--lenient` is a usage error. `--ci` is implied by `GITHUB_ACTIONS=true`: it adds GitHub annotations, a job summary and step outputs (see [output conventions](#output-conventions)).

Exit 0 ok; 1 any step failed; 3 environment.

### `dev`

```text
docusystem dev [--port <n>]
```

Builds once, leniently (a failure of that first build exits 1), serves what would be deployed on `127.0.0.1:<port>` (default 3000), rebuilds on change and live-reloads the browser. It exits 0 on `SIGINT`, `SIGTERM` or `SIGHUP`, and 1 when the first build failed or the port is busy. See [the dev server](build-pipeline.md#the-dev-server).

### `lint`

```text
docusystem lint
```

The Markdown checks only, printed as `level: file:line message`, without building. Exit 0 when there are no errors, 1 otherwise.

### `links`

```text
docusystem links [dist]
```

Crawls an already built site; the default is `<site>/dist`. Exit 0 or 1.

### `info`

```text
docusystem info [--json] [--nav]
```

Prints the package and Jx versions, the runtime, the folders, the resolved branch, the overrides and the exact command that runs Jx by hand on the assembled project. `--json` prints it as JSON; `--nav` prints the sidebar tree. Exit 0.

### `doctor`

```text
docusystem doctor [--json]
```

The maintainer checklist as far as the repository shows it, offline: nothing touches the network. Prints the GitHub and DNS values still to be set. Exit 0 when there are no errors (warnings are allowed), 1 on any error. See [doctor checks](doctor.md).

### `upgrade`

```text
docusystem upgrade [--dry-run] [--workflow-sha <sha>]
```

Re-pins both `uses:` lines of both caller workflows to the commit of the tag `v<installed version>`, appends missing Dependabot entries, and removes nothing else. Exit 0; 1 when the commit cannot be resolved.

### `eject`

```text
docusystem eject (<components/file> | <layouts/file> | <pages/file>)... | --all  [--force]
```

Copies package files into `<site>/overrides/` and records each in `overrides/.ejected.json` with the version and sha256 it came from. Exit 0; 1 for an unknown file or when an override already exists (`--force` overwrites). See [Customizing](../guide/overrides.md).

### `jx`

```text
docusystem jx <jx arguments...>
```

Assembles the project root (pipeline steps 1 to 8; docusystem itself builds nothing), then runs the pinned Jx CLI as `jx <arguments> <root>`, for example `docusystem jx build --verbose`. Everything after `jx` goes to Jx unchanged, so give `--site` before it. The exit code is Jx's. It is a debugging aid: `jx dev` and Jx Studio are not supported.

The root is assembled from empty on every run, so a file that Jx writes into it (such as the `project.schema.json` of `jx schema`) lasts only until the next docusystem command. `jx build` writes to `<root>/dist`, not to `<site>/dist`, and skips the post-build steps. `jx validate` does not work on the generated root, and prints a note saying why; see [Looking inside a build](../guide/troubleshooting.md#looking-inside-a-build).

## Exit codes

| Code | Meaning                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                                                                                             |
| 1    | The command ran and found a problem: config, documents, build, checks or doctor errors                                                                                              |
| 2    | Usage error                                                                                                                                                                         |
| 3    | Environment: Node older than 22.19.0; `DOCUSYSTEM_WORKFLOW_CONTRACT` set and different from the package's; or another docusystem process holds the lock (the message names its pid) |

The environment gate runs before any other work.

## Environment

| Variable                       | Effect                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `CI=true`                      | Implies strict.                                                                                                        |
| `GITHUB_ACTIONS=true`          | Implies `--ci` for `check`.                                                                                            |
| `DOCUSYSTEM_LENIENT=1`         | Equals `--lenient` (ignored by `check`).                                                                               |
| `DOCUSYSTEM_BRANCH`            | The default branch; set by the reusable workflow.                                                                      |
| `DOCUSYSTEM_WORKFLOW_CONTRACT` | Set by `docs-build.yml`. A different value than the package's makes the CLI exit 3, naming the `uses:` line to change. |
| `DOCUSYSTEM_CATALOG_URL`       | A test hook for `--refresh-catalog`.                                                                                   |
| `NO_COLOR`                     | Honored.                                                                                                               |

Besides these, only `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` (with `--ci`), `PATH` and `HOME` are read.

## Strictness

```text
strict = !lenient && (--strict || CI=true)
```

`check` is always strict and `dev` is always lenient. Passing both `--strict` and `--lenient` is a usage error.

- **Strict.** The build generates `content.docs.links: "error"`, so Jx itself fails and lists every broken link. The build fails on any lint error, any Jx output line matching `^(Content\b|Warning:|Error)`, and any failed assertion. Nothing is published.
- **Lenient.** The build generates `links: "warn"` and downgrades lint errors and those lines to warnings.
- **Never downgraded:** config errors, a failing `jx`, failed output assertions and the contrast gate.

Leniency is a per-run flag for the first pass, not a file setting, and the reusable workflows expose no lenient input.

## Output conventions

Every stage prints with one prefix: `preflight:`, `assemble:`, `stage:`, `lint:`, `nav:`, `jx:`, `postbuild:`, `assert:`, `contrast:`, `links:`, `overrides:` and `catalog:`.

With `--ci`, every error or warning that has a location is also printed as a GitHub annotation: `::error file=docs/x.md,line=N,title=<stage>::message`, with `%0A` for newlines. `check --ci` then appends a summary to `$GITHUB_STEP_SUMMARY`, with the package and Jx versions, the runtime, overrides and the catalog source, so a red run can be read without a checkout. It writes `dist=<absolute path>`, `page-url=https://<domain>/` and `pages=<n>` to `$GITHUB_OUTPUT`.

On a failed Jx run the build prints `docusystem: jx build failed. The assembled project is <root>; run: <execPath> <jx.js> build <root>` and everything it knows.

## Symlink policy

For `docs/`, `overrides/` and `public/`: a symbolic link is followed only when its real path lies inside the repository root and not inside `.git/`, `node_modules/`, or the site's own `.docusystem/` and `dist/`. Directory cycles are cut. Any other symbolic link is skipped and reported:

```text
stage: docs/x.md is a symbolic link outside the repository: not published
```

Under strict, a skipped symbolic link is an error. Nothing the build writes is a symbolic link, except the links to the installed Jx packages inside the generated root.

## Deletion policy

The CLI deletes only paths it computed from the site folder: `<site>/.docusystem/**` and `<site>/dist`. There is no `--out` option, so the published path is fixed.

## Repository root and paths

The repository root is the nearest ancestor of the site folder that contains `.git` (a directory or a file), else the parent of the site folder. The docs folder (default `../docs`) is resolved against the site folder and must lie inside the repository root.
