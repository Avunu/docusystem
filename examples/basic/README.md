# Docusystem example

A sample repository for the documentation shell of [`@avunu/docusystem`](https://github.com/Avunu/docusystem): the Markdown is in [docs/](docs/README.md), and everything else that makes it a site is in [docs-site/](docs-site) and [.github/workflows/](.github/workflows).

It is a complete adopting repository, kept in the package's own repository so that its build is tested against the packed tarball on every change. It contains no application worth running: [src/worker.ts](src/worker.ts) is a stand-in for the code a real project would have.
