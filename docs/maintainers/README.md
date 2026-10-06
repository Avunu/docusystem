---
title: Maintainers
description: Where to find the release runbook, the contribution rules and the security policy, how this repository's pipelines fit together, and the changes asked of Jx.
order: 4
updated: 2026-10-06
tags: [maintainers, releases]
---

This section is for the people who change and release `@avunu/docusystem`. A project that only uses the system does not need it.

| Document                                 | Contents                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [MAINTAINING.md](../../MAINTAINING.md)   | The release runbook, the one-time npm and GitHub settings, and the GitHub behaviors still to be confirmed |
| [CONTRIBUTING.md](../../CONTRIBUTING.md) | Toolchain, commit rules and how the repository is organized                                               |
| [SECURITY.md](../../SECURITY.md)         | How to report a vulnerability                                                                             |
| [Upstream asks](upstream-asks.md)        | The changes asked of Jx, and the code each one would delete here                                          |

## The pipelines of this repository

| Workflow                            | Runs                                     | Does                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                            | Pull requests, pushes to `main`, by hand | Format, lint, types, unit and integration tests and build; the pack allowlist and budget, `publint` and `attw`; the consumer matrix against the packed tarball; the browser suites; `actionlint` and `zizmor`; the pull-request title check; and, on release branches, the fleet job. One required check, `ci`, aggregates them and tolerates skipped jobs. |
| `release.yml`                       | Pushes to `main`, daily                  | release-please keeps the release pull request open; in the same file a job without the OIDC token builds the tarball, and a job that runs none of the repository's code publishes it under the `npm` environment, with provenance                                                                                                                           |
| `docs-build.yml`, `docs-deploy.yml` | Called by projects                       | The reusable workflows; see [Workflows](../reference/workflows.md)                                                                                                                                                                                                                                                                                          |
| `fleet.yml`                         | Weekly, by hand                          | Adopts the other Avunu repositories from their READMEs and checks them                                                                                                                                                                                                                                                                                      |
| `catalog.yml`                       | Weekly                                   | Refreshes the bundled project catalog and opens a pull request if it changed                                                                                                                                                                                                                                                                                |
| `jx-latest.yml`                     | Weekly                                   | Installs the latest Jx over the pins, runs the canary and the example build, opens an issue on failure                                                                                                                                                                                                                                                      |

Dependabot in this repository groups `@jxsuite/*` updates (`fix(deps)`, no cooldown), the runtime dependency `yaml` (`fix(deps)`), development tooling (`chore(deps-dev)`) and GitHub Actions (weekly, cooldown 7 days).
