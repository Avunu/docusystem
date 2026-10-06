# Contributing

Thank you for helping. This package is shared by every Avunu open-source documentation site, so changes are small, reviewed and tested against a real build.

## Set up

You need Node 22.19.0 or newer (24 is what CI builds and publishes with) and npm. Bun 1.4 or newer is optional and only used to test the Bun runtime and installer paths.

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` is the local gate: formatting, lint, types and the unit and integration tests. The `check` job of CI runs the same and then builds. Use `--ignore-scripts` as consumers do: the package has no install script, and `prepack` builds `dist/` only for publishing.

| Command                                        | What it does                                                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run format`                               | Format everything with `oxfmt` (it also formats Markdown, including table alignment)                                    |
| `npm run format:check`                         | The check CI runs                                                                                                       |
| `npm run lint`                                 | `oxlint`                                                                                                                |
| `npm run typecheck`                            | `tsc --noEmit`                                                                                                          |
| `npm test`                                     | `vitest run`: the `unit` project, and the `integration` project that builds with the real pinned Jx (60 second timeout) |
| `npm run build`                                | Compile `src/` to `dist/`                                                                                               |
| `npm run check:pack`                           | What would be published: the allowlist, the budget and the required files                                               |
| `npm run check:publint`, `npm run check:types` | `publint --strict` and `attw --profile esm-only` on the packed package                                                  |
| `npm run test:pack`                            | Pack the tarball, install it into a copy of `examples/basic` and run `check` on it                                      |
| `npm run sync-catalog`                         | Regenerate the bundled project catalog (`--check` fails if it would change)                                             |

`npm run test:pack -- --pm bun --runtime bun --linker isolated` exercises the other installer, runtime and linker combinations that CI runs. `--workspace` places the example in an npm-workspaces monorepo.

## Rules every change keeps

These hold for the whole package. A change that needs to break one is a design discussion first.

1. **Black box.** Jx is touched only through documented surfaces: a plain project root, `jx build <root>` spawned with `process.execPath`, `extensions`, `$src: "npm:..."` sidecars and `content.<type>.links`. No Jx extension, no hooks, no mutation of Jx internals.
2. **One source per fact.** The seven identity keys are written once, in `docusystem.config.json`. Everything else is derived.
3. **Strict in CI, never configured.** `CI=true` fails on any document problem. Leniency is a per-run flag, never a file setting, and the reusable workflows expose no lenient input.
4. **Everything is recorded.** Each build writes `.docusystem/manifest.json` and `.docusystem/jx.log` and prints the command to run Jx by hand.
5. **Real bytes only.** Published files are copies, never symbolic links.
6. **No scripts, no surprises at install or build.** No `postinstall` or `prepare` script runs for consumers; no network access during `build` except with `--refresh-catalog`; the Jx packages are pinned exactly; no new runtime dependency beyond `@jxsuite/compiler`, `@jxsuite/parser`, `@jxsuite/runtime`, `@jxsuite/search` and `yaml`.
7. **Least privilege.** The build job has `contents: read` and no secrets, the deploy job runs no project code, and no workflow that a pull request can trigger asks for `pages: write` or `id-token: write`. A job that holds `id-token: write` runs none of this repository's code: the release builds its tarball in a job without the token and publishes that file in the one with it.
8. **The package picks Jx.** Shells never name a Jx package.
9. **Overrides are visible and cost something.** Every override and every `jx` fragment is printed on build, recorded in the manifest and reported by `doctor` when it can drift.
10. **Trust assertions, not Jx.** Jx ignores what it does not understand and still exits 0, so the output is asserted positively.
11. **Both runtimes first-class for local use.** `build`, `check` and `dev` run on Node and on Bun. CI and deploys use Node 24 only.

Source conventions: TypeScript with ES modules, `.js` specifiers for relative imports, module `nodenext`, declarations on and no source maps. `src/` uses Node APIs only, never Bun APIs. Compiled JavaScript is what ships, because Node refuses TypeScript inside `node_modules`.

## Commits and pull requests

Pull requests are squash-merged, so **the pull request title becomes the commit message**, and release-please reads it to decide the next version and to write the changelog. Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, `perf:`, `style:`, `build:` and `revert:`. Mark a breaking change with `!` (`feat(config)!: rename tagline to summary`) and explain it in a `BREAKING CHANGE:` footer. Only `feat`, `fix`, `perf`, `revert` and breaking changes make a release.

Do not put a raw HTML tag, such as the picture element's, in a title or a `BREAKING CHANGE:` note. release-please re-parses its own release notes as HTML, and a stray tag makes it skip the release without failing. `.github/workflows/ci.yml` rejects it; write "the picture element" instead.

A good pull request says what changed and why, how it was verified, and any decision a maintainer should confirm.

### What needs a note in the pull request

- Anything that changes a page URL, a `docusystem.config.json` key, a command or option, an exit code, a design-token name, a file or tag name under `site/`, or a reusable workflow's inputs, permissions or job names. These are the breaking changes listed under [Versioning](README.md#versioning).
- A new dependency, with the reason. Dependencies are exact-pinned, and every runtime one is installed in every documentation site's CI. A new runtime dependency is a design change.
- A renamed or removed file under `site/`: the contents of a file are outside semver, but its name is not.

## How the repository is organized

The package was built as twelve work packages, each owning a set of paths and its own tests. The split is still the quickest way to find things, and a change that crosses areas should say so in its pull request.

| Area                  | Paths                                                                                                                                                                                 | Holds                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Foundation            | `package.json`, tooling configs, `LICENSE`, `src/cli.ts`, `src/main.ts`, `src/index.ts`, `src/commands/types.ts`, `src/lib/{types,package-info,platforms,fsutil}.ts`, `test/support/` | Command-line dispatch, the environment gate, shared types, file-system helpers with the symlink and deletion policies |
| Config and catalog    | `config.schema.json`, `src/lib/{config,preflight,catalog}.ts`, `site/data/`, `scripts/sync-catalog.mjs`, `test/config/`                                                               | Validating the config, the bundled project catalog, preflight                                                         |
| Assembly              | `src/lib/{assemble,project,overrides,jx,lock}.ts`, `test/assemble/`                                                                                                                   | The generated Jx project root, `project.json` generation, overrides and eject, the lock                               |
| Content               | `src/lib/{stage,repo-links,markdown,frontmatter,lint,docs,nav,slug}.ts`, `test/content/`                                                                                              | Staging the Markdown, link rewriting, the lint rules, the sidebar                                                     |
| Output                | `src/lib/{postbuild,tidy,assert,links,contrast}.ts`, `test/output/`                                                                                                                   | Post-build fixes, the output assertions, the link crawl, the contrast gate                                            |
| Pipeline and commands | `src/lib/{pipeline,strict,devserver,ci}.ts`, `src/commands/{build,check,lint,links,info,jx,dev}.ts`, `test/commands/`, `test/integration/`, `test/fixtures/`                          | The build pipeline, strictness, the dev server, the real-Jx canary                                                    |
| Init, doctor, eject   | `src/commands/{init,upgrade,doctor,eject}.ts`, `src/lib/{gitremote,dependabot,automerge,pin,workflows}.ts`, `scaffold/`, `test/init/`                                                 | Writing and checking a project's shell                                                                                |
| Site assets           | `site/` (except `site/data/`), `test/site/`                                                                                                                                           | The Jx project the package ships: components, layouts, pages, tokens, fonts, brand marks                              |
| Workflows and release | `.github/`, `release-please-config.json`, `.release-please-manifest.json`, `scripts/check-*.mjs`, `test/workflows/`                                                                   | The reusable workflows, this repository's CI and release                                                              |
| End to end            | `examples/`, `verify/`, `fleet.json`, `scripts/{test-pack,assert-dist,compare-dist,fleet}.mjs`, `test/e2e/`                                                                           | The example repository, the tarball tests, the browser suites, the fleet job                                          |
| Documentation         | `README.md`, `CONTRIBUTING.md`, `MAINTAINING.md`, `SECURITY.md`, `docs/`                                                                                                              | These files and the documentation tree                                                                                |
| Migration             | `scripts/{migrate-pilot,rehearse-pilots}.mjs`, `scripts/legacy/`, `test/migrate/`                                                                                                     | Development-only tools for moving the first sites; never in the published tarball                                     |

Rules that came with that structure:

- **The interfaces between areas are frozen.** The signatures exported by the modules in `src/lib/` and `src/commands/` are what the other areas compile against. Add an export if you need one; changing or removing one changes every caller.
- **Test next to the area.** Tests live in the folder named for the area above. Behavior that needs a neighbouring area is tested with fixtures, and the integration tests run the real pinned Jx.
- **Seeds are references.** When code was adapted from a prototype, it was copied and changed, not imported.
- **No new dependencies** without a reason in the pull request (see rule 6 above).
- **Documentation follows the code.** A change to a command, option, key, file name or exit code changes the README and `docs/` in the same pull request. Every command, option, key and file the documentation names must exist.

## The documentation tree

`docs/` is the package's own documentation, written to the same conventions it asks of projects: front matter with `title` and `description`, no `# Heading` in the body, GitHub alerts for callouts, relative links with `%20` for spaces, language-tagged code blocks and `[PLACEHOLDER]` for anything unknown. It must build with the packaged CLI: point a temporary shell's config at it and run `docusystem check`.

The repository is public. Do not commit client names, client domains, customer data, secrets or prices. Describe clients by industry only. Examples use `Avunu/docusystem-example` and the public names of the pilot repositories.

## Releases

Releases are cut by merging the release pull request that release-please keeps open. Nothing is published from a laptop. [MAINTAINING.md](MAINTAINING.md) has the runbook.
