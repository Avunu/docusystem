---
title: Commands
description: The commands of the docusystem command line and its exit codes.
order: 8
updated: 2026-10-06
tags: [reference]
---

# Commands

`docusystem <command>` operates on the site folder: the folder with `docusystem.config.json`, found from the current folder or `./docs-site`.

| Command   | What it does                                                          |
| --------- | --------------------------------------------------------------------- |
| `init`    | Writes the shell of a docs site into a repository.                    |
| `build`   | Builds the site into `docs-site/dist`.                                |
| `check`   | What CI runs: a strict build, a contrast gate and a crawl of links.   |
| `dev`     | Serves the site on `127.0.0.1` and rebuilds when the Markdown does.   |
| `lint`    | Checks the Markdown only.                                             |
| `links`   | Crawls a site that is already built.                                  |
| `info`    | Prints versions, folders, overrides and how to run Jx by hand.        |
| `doctor`  | The maintainer checklist, as far as the repository shows it.          |
| `upgrade` | Re-pins the workflows to the installed version.                       |
| `eject`   | Copies a package file into `overrides/` so the project can change it. |
| `jx`      | Runs the pinned Jx on the assembled project, for debugging.           |

## Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Success.                                                                            |
| 1    | The command ran and found a problem.                                                |
| 2    | The command line is wrong.                                                          |
| 3    | The environment is wrong: Node too old, or another `docusystem` is already running. |

> [!NOTE]
> Strictness is never configured in a file: `CI=true` and `check` are strict, `dev` is lenient, and `build` takes `--strict` or `--lenient`.

See [troubleshooting](../guide/troubleshooting.md) for the failures people meet first.
