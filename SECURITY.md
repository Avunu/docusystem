# Security policy

`@avunu/docusystem` is installed in the CI of every Avunu open-source documentation site, and its reusable deploy workflow runs there with permission to publish to GitHub Pages. We treat reports about it seriously.

## Reporting a vulnerability

Use **[private vulnerability reporting](https://github.com/Avunu/docusystem/security/advisories/new)** on this repository. Please do not open a public issue or pull request for a suspected vulnerability.

If you cannot use GitHub, email [PLACEHOLDER: security mailbox at avunu.net, to be confirmed by Avunu LLC before launch].

Include what you can of the affected version, the steps to reproduce it and what an attacker gains.

We aim to acknowledge a report within three business days and to agree a disclosure date with you once a fix is ready. We credit reporters in the release notes unless you would rather we did not.

## Supported versions

Fixes land on `main` and ship in the next release. Only the latest release of the current major version is supported. Before 1.0.0 that means the latest release.

## Scope

In scope:

- The published npm package `@avunu/docusystem`, including the CLI and the files it writes into a project.
- The reusable workflows `docs-build.yml` and `docs-deploy.yml` in `.github/workflows/`: for example a way to run code with the deploy job's permissions, to publish to a repository's Pages site from a pull request, or to read a secret.
- This repository's release pipeline.

Out of scope:

- Vulnerabilities in a documentation site that come from its own Markdown, configuration, overrides or workflows. A pull request can change those and run code in the build job by design; that job has a read-only token and no secrets.
- Vulnerabilities in Jx itself. Report those to [jxsuite/jx](https://github.com/jxsuite/jx/security).
- Denial of service by volume.

## Design notes for reporters

These are the properties the system intends to have. A way to break one is a vulnerability.

- The build job of the reusable workflow has `contents: read` and no secrets. The deploy job executes no project code. No workflow that a pull request can trigger asks for `pages: write` or `id-token: write`.
- Callers pin the reusable workflows by commit, and every action in them is pinned by commit.
- No install script runs for consumers, the package makes no network access during a build unless `--refresh-catalog` is passed, and the CLI deletes only paths inside the site folder's `.docusystem/` and `dist/`.
- Files that are published are copies; a symbolic link that leaves the repository is skipped, never followed.

## Verifying a release

Releases are published from GitHub Actions with npm trusted publishing, so each version carries a provenance attestation. In a project that uses it, `npm audit signatures` verifies the installed package against it, and the reusable build workflow fails when the package has none.
