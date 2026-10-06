---
title: Reference
description: The complete lists of config keys, commands and options, exit codes, build steps, workflow settings, doctor checks and the versioning policy.
order: 3
updated: 2026-10-06
tags: [reference, lookup]
---

The reference states what the system does, without the explanation the [guide](../guide/README.md) gives.

| Page                                          | Contents                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Configuration](configuration.md)             | Every key of `docusystem.config.json`, how the branch is found, the theme, images and `jx` rules.         |
| [Command line](command-line.md)               | The eleven commands, their options, exit codes, environment variables, strictness and output conventions. |
| [Doctor checks](doctor.md)                    | Every row of the maintainer checklist that `docusystem doctor` runs.                                      |
| [Build pipeline](build-pipeline.md)           | The steps from the shell to `dist`, the generated project root, the manifest and the dev server.          |
| [Workflows](workflows.md)                     | The two reusable GitHub Actions workflows: inputs, permissions, steps and the trust model.                |
| [Versioning and compatibility](versioning.md) | The semver surface, the Jx pins, the workflow contract, runtime support and the package exports.          |
