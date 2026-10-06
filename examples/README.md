# Examples

`basic/` is a complete adopting repository: the Markdown of a small documentation site in `docs/`, the thin shell that `docusystem init` writes (`docs-site/`, the two caller workflows and the Dependabot entries), and a stand-in source file, `src/worker.ts`, for the documentation to link to. Its identity is the sample project `Avunu/docusystem-example`.

It is not part of the published package. It is what the package is tested against:

| Who uses it             | How                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/test-pack.mjs` | Copies it to a temporary repository, installs the packed tarball into its shell, runs `check` and asserts the output.          |
| `verify/`               | Builds a copy and runs the browser suites on it: axe, the drawer, the project switcher, screenshots.                           |
| `test/e2e/`             | Reads it as a person would, and checks it against the rules of the architecture record (the shell, the callers, the Markdown). |

The callers in `.github/workflows/` carry the placeholder commit `0000000000000000000000000000000000000000 # v0.0.0`: `docusystem init` writes the commit of the release tag of the installed version in its place. The shell depends on `@avunu/docusystem` `^0.1.0`, which `test-pack` replaces by the tarball it has just packed; the example therefore has no lockfile.

Its `.oxfmtrc.json` keeps the repository's formatter out of `docs/` (a formatter breaks a page that starts with a copyright comment, which is what `docs/guide/troubleshooting.md` does on purpose) and lets the callers' `paths:` lists stay on one line, as `init` writes them.
