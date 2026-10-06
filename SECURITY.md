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
- A way for documentation Markdown (raw HTML, a link, an image, a `:name{...}` directive, a `${...}` or a file that a page links to) to run code in the build job, or in a reader's browser on a published site, past the staging, the lint, the output assertions and the Content-Security-Policy described below.

Out of scope:

- Vulnerabilities in a documentation site that come from its own configuration, overrides or workflows. A pull request can change those and run code in the build job by design; that job has a read-only token and no secrets. Markdown is not in this list: a page is data in the build, and untrusted on the published site (see the two design notes below about Markdown).
- Vulnerabilities in Jx itself. Report those to [jxsuite/jx](https://github.com/jxsuite/jx/security).
- Denial of service by volume.

## Design notes for reporters

These are the properties the system intends to have. A way to break one is a vulnerability.

- The build job of the reusable workflow has `contents: read` and no secrets. The deploy job executes no project code. No workflow that a pull request can trigger asks for `pages: write` or `id-token: write`.
- A page of Markdown is data in the build: a `${...}` in it, in any spelling, never reaches Jx as a template, so a pull request that changes only `docs/` cannot run code in the build job.
- Markdown is not trusted on the published site, which is served from the project's own domain (same-site with the client portal). Raw HTML may use only text, table and image elements, no event-handler or `style` attribute, and addresses may only be http, https, mailto, tel or relative: `docusystem lint` refuses the rest with the file and line, the output assertions refuse any built page that holds a script, an event handler, an unsafe address or an embedded page, and any published file that would run when opened (HTML, script, active SVG or XML), in every mode, and every page carries a Content-Security-Policy meta that names the page's own inline scripts by hash and refuses all others. A way to get a script to run in a reader's browser from a documentation pull request is a vulnerability. Not covered: pull requests that change `docs-site/` (the config, overrides, `public/`), which are reviewed as code.
- Callers pin the reusable workflows by commit, and every action in them is pinned by commit.
- The release pipeline publishes with an OIDC token that only one job can read, and that job runs no code of this repository or its dependencies: it publishes a tarball that a job without the token built.
- No install script runs for consumers, the package makes no network access during a build unless `--refresh-catalog` is passed, and the CLI deletes only paths inside the site folder's `.docusystem/` and `dist/`.
- Files that are published are copies; a symbolic link that leaves the repository is skipped, never followed.

## Verifying a release

Releases are published from GitHub Actions with npm trusted publishing, so each version carries a provenance attestation. In a project that uses it, `npm audit signatures` verifies the installed package against it, and the reusable build workflow fails when the package has none.
