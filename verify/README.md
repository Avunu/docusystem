# Browser suites

Maintainer tooling of `@avunu/docusystem`, not part of the published package. The suites build throwaway adopting repositories from the **packed** package and check the sites they make in a real Chrome. They run on [Bun](https://bun.sh) with `playwright-core` and `@axe-core/playwright`; the site under test is built by Node, as the deployed one is.

```sh
npm ci                       # in this folder: installs the two dependencies from package-lock.json
bun run.ts --tarball ../avunu-docusystem-0.1.0.tgz --out /tmp/verify
```

`run.ts` runs everything; each suite also runs alone on the Jx output of a built site, `<site>/.docusystem/site/dist` (its parent is the assembled Jx root, which holds the `docusystem.config.json` and `data/projects.snapshot.json` the suites read).

| Suite         | What it proves                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `axe.ts`      | WCAG 2.1 A and AA with axe-core on every page at three widths in both colour schemes, and again with the project list, the search palette and the drawer open: zero violations. |
| `csp.ts`      | The Content-Security-Policy of the pages from both sides: the site works under it (search, switcher, theme, drawer, copy buttons: no violation, no script error), and markup injected into a built page (event handlers, a javascript: link, inline and foreign scripts, a frame, a form, a new base) does nothing. |
| `drawer.ts`   | The mobile drawer is modal: focus moves in and back, nothing behind it can be reached, Escape and a click outside close it.                                                     |
| `switcher.ts` | The project switcher: pre-rendered list, live catalog swap, keyboard disclosure, no layout shift, hostile catalogs. Needs a site whose slug is a real catalog slug.             |
| `fences.ts`   | Every fenced code block of the Markdown comes out of the build with exactly its text.                                                                                           |
| `edge.ts`     | The edge-case adopter of `fixtures/` (a README that starts with a comment and a badge, links written from the repository root, template-looking text, folder pages).           |
| `shots.ts`    | Screenshots of every page at 1440, 768 and 390 pixels in both schemes, plus `states.ts` for the interactive states. For a person to look at: nothing is compared.              |

The suites never touch the network: `https://avunu.net/projects.json` is answered from the catalog the site was built with, and images of other sites by a placeholder. Chrome is found at `$CHROME_BIN` or in the usual places.
