---
title: Writing documentation
description: The Markdown conventions that work on GitHub, in Obsidian and on the site, and the few constructs the site cannot render.
order: 2
updated: 2026-10-06
tags: [guide, markdown, authoring]
---

You write Markdown in `docs/` and nothing else. The conventions below work on GitHub, in Obsidian and on the published site at once, except where [what does not render](#what-does-not-render) says otherwise.

## Files and folders

- `docs/README.md` (or `docs/index.md`, in any letter case) is the documentation home at `/docs/` and is required. When it is missing the build stops and says `cp README.md docs/README.md`.
- Every other `.md` file is a page at `/docs/<path>/`: `docs/Install Steps.md` is `/docs/install-steps/`.
- A folder is a section of the sidebar. Its `README.md` (or `index.md`) is the section's "Overview".
- Files and folders whose names start with `.` or `_`, and `node_modules`, are ignored.
- The Markdown folder is `docs/` beside the site folder unless the config's [`docs` key](../reference/configuration.md#optional-keys) says otherwise. It must lie inside the repository.
- Images and downloads go anywhere under `docs/` and are linked relatively: `![Diagram](images/flow.png)`.
- A symbolic link is followed only when its target is inside the repository. Any other one is skipped and reported, and under strict that is an error (see [troubleshooting](troubleshooting.md#a-symbolic-link-is-not-published)).

## Front matter

Front matter is optional. Without it a page is titled by its first `# Heading` (or its file name) and described by its first paragraph. These keys are understood:

| Key           | Meaning                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| `title`       | The page title. Wins over the first heading.                                               |
| `description` | One sentence under the title, in search results and in link previews.                      |
| `nav_title`   | A shorter name for the sidebar.                                                            |
| `order`       | A number. Lower comes first; pages without one come last, alphabetically.                  |
| `hidden`      | `true` publishes the page but leaves it out of the sidebar and of previous and next links. |
| `draft`       | `true` keeps the page out of the site entirely.                                            |
| `publish`     | `false` does the same as `draft: true`.                                                    |
| `updated`     | A date such as `2026-10-01`, shown under the title.                                        |
| `tags`        | A list, shown under the title.                                                             |

Other keys (the vault's `slug`, `category` or `status`, for instance) are not used by the site. A field of the wrong type (`draft: "yes"`, `order: "2"`) is reported by the build and fails it in CI: write `true` and `2`.

```markdown
---
title: Repair a corrupted table
description: Find and repair a damaged table without losing the site's data.
nav_title: Repair a table
order: 3
updated: 2026-10-01
tags: [database, repair]
---
```

### The page title

The title is shown once, as the page's single `h1`. The first `# Heading` that says the same as the title (ignoring case and punctuation) is that `h1`, wherever it stands in the file (after a badge, a comment or a logo), and links to its anchor keep working. Every other level-1 heading is shown as a section heading, so a page always has exactly one `h1`.

A comment above the front matter, such as a copyright stamp that some pre-commit hooks add, is tolerated: staging moves it below the front matter for the build. GitHub and Obsidian still read the file as written and then show the front matter as text, so keep `docs/` out of such hooks.

## Callouts

Use GitHub's alert notation. The five types are `NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION`:

```markdown
> [!NOTE]
> Background that helps but is not required.

> [!TIP] A custom title
> The Obsidian form with a title works too.

> [!WARNING]
> Something that can break a site, lose data or weaken security.
```

They render as callouts on the site and as alerts on GitHub.

## Links and images

- Link to other pages by file, relative to the file you are in, with `%20` for a space: `[Configuration](guides/configuration.md#options)`, `[Install Steps](Install%20Steps.md)`. The site rewrites them to the page's address. A link to a heading uses the heading's anchor.
- A link or image to a file of the repository that is not a page (a source file, `LICENSE`, another README, a folder of examples) becomes a link to it on GitHub, on the repository's default branch. That works whether you wrote it from `docs/` (`../worker/README.md`) or from the repository root, as in a README copied into `docs/` (`worker/README.md`). Each rewrite is listed in the build output.
- A link written from the repository root to a page inside `docs/` (`docs/chat.md`) is made relative to the file you are in.
- A link to a page that does not exist, or that is a draft, is shown as plain text and fails the CI build with the file and the target named. While you fix them, `docusystem build --lenient` reports them as warnings.
- Raw HTML gets the same repairs, because a README uses it for its centred logo and its badges: the `href` of an `<a>`, the `src` of an `<img>`, `<video>`, `<audio>` or `<source>`, a `poster`, and each file of a `srcset`. `<p align="center"><img src="./assets/logo.png" alt="Logo"></p>` and `<div align="center"><a href="docs/chat.md">Chat</a></div>` pass a strict build, and each rewrite is listed in the build output. Tags in code and in HTML comments are left as written. Prefer Markdown links all the same: a raw `<a>` inside a paragraph is not kept (see [what does not render](#what-does-not-render)).

## Code

- Give every code block a language. These are highlighted at build time, in light and dark: `json`, `jsonc`, `js` or `javascript`, `ts` or `typescript`, `md` or `markdown`, `html`, `css`, `bash`, `sh` or `shell`, `yaml` or `yml`, `sql`, `php`, `python` or `py`, `ruby` or `rb`, `nix`, `nginx`, `caddyfile`, `toml`, `ini`, `diff`, `xml` and `dockerfile`.
- `text` (and `txt`, `plain`, `output`, `log`) is plain on purpose. Any other language, such as `rust`, `go`, `vue`, `dotenv`, `console`, `jinja` or `scss`, is shown as plain code and the build prints a `postbuild: warning:` naming the page. It never fails the build.
- Shell commands carry no `$` or `#` prompt, so they can be pasted. Show their output in a separate `text` block.
- Write placeholders as `<UPPER_SNAKE_CASE>` and use `example.com` for domains. Never paste credentials or customer data.

## What does not render

Jx drops or reshapes a few constructs that GitHub and Obsidian handle. The build reports each one as `docs/<file>:<line>` with what to write instead. The ones marked "error" lose text or leave an empty link, so a strict build (every CI run) fails on them; the others are warnings.

| Written                                                   | What the site does                                              | Build                           |
| --------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------- |
| Reference-style links (`[text][ref]` and `[ref]: url`)    | The text of every such link vanishes                            | error in CI                     |
| Footnotes (`[^1]` and `[^1]: note`)                       | The marker and the note vanish                                  | error in CI                     |
| Inline HTML such as `<kbd>`, `<b>` or `<a id>`            | The text stays, outside the element                             | warning                         |
| `<a href>` around an `<img>` in a paragraph (a badge)     | The image stays, the link is lost                               | error, fails lenient builds too |
| An inline `<a href>`                                      | The text stays, the link is lost                                | error, fails lenient builds too |
| A `<div>` or `<details>` with a blank line inside         | An empty element, then the content                              | warning                         |
| Task lists (`- [ ]`)                                      | Plain list items                                                | warning                         |
| Table column alignment (`:---:`)                          | Columns are left-aligned                                        | warning                         |
| `${...}` in an address, a URL, an HTML tag or a directive | The build writes it inert, so the address is not what you wrote | error in CI                     |

A raw `<a href>` in a paragraph, around text or around an image, is worse than a lost link: Jx writes an empty link, `<a href></a>`, and puts the text or the image after it. The post-build assertion "no page has an empty link" then fails every build, strict or lenient, and nothing is published. Under `--lenient` the lint error is printed as a warning, but the assertion still fails, so fix it either way: write `[text](url)`, and `[![alt](image)](url)` for a badge. An anchor without `href` (`<a id="top"></a>`) only warns. A badge inside a block such as `<p align="center">` is not affected.

Block HTML without a blank line inside it (`<p align="center"><img ...></p>`) works, as do `<br>`, `<img>` and HTML comments. In Markdown content `${...}` is literal in prose, code spans, code blocks, headings and front matter, so `${HOME}` stays `${HOME}`.

A `${...}` in an address (a link, an image, an autolink or a bare URL), in a raw HTML tag, in a directive or in the language of a code fence is an error. Jx evaluates every string that holds `${` as JavaScript when it builds an attribute, so a page that held one could run code in the build, in CI too. That never happens: staging writes every `${` of a page, in code and front matter as well and in every spelling that Markdown, HTML or YAML decodes to it (`&#36;{`, `$\{`), with a zero-width space between `$` and `{`, and the post-build step writes the plain text back wherever it is text. In an address or an attribute the zero-width space stays, so the link does not say what you wrote: write the address as `%24%7B...%7D`, or put the text in a code span or a code block.

Run `docusystem lint` to see only these checks, with file and line, without building.

## Strict and lenient

`CI=true` makes every document problem fail the build, and `check` is always strict. Leniency is never a file setting: it is a per-run choice for the first pass, `docusystem build --lenient` (or `DOCUSYSTEM_LENIENT=1`). `docusystem dev` is always lenient. See [strictness](../reference/command-line.md#strictness).
