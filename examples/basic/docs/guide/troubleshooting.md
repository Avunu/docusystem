<!-- Copyright (c) 2026 Avunu LLC -->
---
title: Troubleshooting
description: What to do when a check fails.
order: 6
updated: 2026-10-06
tags: [guide]
---

# Troubleshooting

The comment above this page's front matter is a copyright stamp of the kind a pre-commit hook adds. GitHub shows the front matter as text, so the build moves the comment below it and the site is not affected.

## A document problem fails the build

In CI (`CI=true`) and in `docusystem check`, any document problem fails the build and every problem is listed with its file and line: a broken link, a missing image, a reference-style link or a footnote, which the site would silently lose.

```bash
npx docusystem lint
```

> [!TIP]
> While working through a first pass over existing Markdown, `docusystem build --lenient` reports the same problems as warnings.

## The wrong Node

The CLI needs Node 22.19 or newer (or Bun 1.4 or newer). On an older Node it exits with status 3 before doing anything.

## Images on NixOS

Image optimization uses a native module that needs the system's C++ runtime library. Where that is not available, set `images` to `off` in the config file; the images are then copied as they are.

> [!CAUTION]
> Do not copy the generated `.docusystem/` folder or `dist/` into the repository: both are rebuilt on every run and are ignored by `.gitignore`.

Command reference: [docusystem commands](../reference/commands.md).
