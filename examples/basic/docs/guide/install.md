---
title: Install
description: Add the documentation site to a repository.
order: 3
updated: 2026-10-06
---

# Install

Run one command in the repository root. It reads the `origin` remote and the Avunu project catalog, so most options are filled in for you:

```bash
npx @avunu/docusystem init --from-readme
```

> [!TIP]
> Add `--dry-run` to see every file and change without writing anything.

## Check it

Install the one dependency and run the same check that CI runs:

```bash
cd docs-site
npm install
npm run check
```

> [!WARNING]
> A push to the default branch publishes the site once the repository variable `DOCS_SITE_ENABLED` is `true`. Review Dependabot pull requests before merging them.

The files `init` wrote are described on the [configuration](configuration.md) page, and the [config file](../../docs-site/docusystem.config.json) of this example is on GitHub.
