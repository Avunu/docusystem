# Changelog

## 0.1.0 (2026-10-06)


### Features

* assemble the generated Jx project root, the project.json, overrides and the lock ([#7](https://github.com/Avunu/docusystem/issues/7)) ([01f7bfb](https://github.com/Avunu/docusystem/commit/01f7bfbbbfc401f9d575a6a4ddba49ee8459440d))
* build pipeline, strictness, commands and dev server (WP5) ([#8](https://github.com/Avunu/docusystem/issues/8)) ([d530661](https://github.com/Avunu/docusystem/commit/d530661c0099008f4bf65646375aa7d9e02f0abc))
* command line entry, dispatch and environment gate ([a3fee16](https://github.com/Avunu/docusystem/commit/a3fee16fa78d04efc820e3f7728cf90745e73189))
* configuration, project catalog and preflight ([#6](https://github.com/Avunu/docusystem/issues/6)) ([3e65041](https://github.com/Avunu/docusystem/commit/3e65041b285270b46d1e0506ae7c645d90d8180b))
* foundation and shared kernel (WP0) ([fc9afe2](https://github.com/Avunu/docusystem/commit/fc9afe2ff879f4828b07dfe383e7ba584c162014))
* init, upgrade, doctor and eject ([#9](https://github.com/Avunu/docusystem/issues/9)) ([d7b5e2c](https://github.com/Avunu/docusystem/commit/d7b5e2cd08caad3045c40dd835694c44e2a22e87))
* process the built output (post-build fixes, assertions, link crawl, contrast gate) ([#5](https://github.com/Avunu/docusystem/issues/5)) ([3a4de2d](https://github.com/Avunu/docusystem/commit/3a4de2d3d8c3a8800e13ea53c362b9bcb5066f5e))
* shared types, package facts and file-system helpers ([366477c](https://github.com/Avunu/docusystem/commit/366477ca024541928da6a13a57134be00c756da6))
* site assets, the Jx project files of the documentation site (WP7) ([#2](https://github.com/Avunu/docusystem/issues/2)) ([6247ceb](https://github.com/Avunu/docusystem/commit/6247cebd8a68690a5403bb5474b8e0b18a5264cc))
* stage, lint and navigate the documentation Markdown ([#11](https://github.com/Avunu/docusystem/issues/11)) ([456f2d1](https://github.com/Avunu/docusystem/commit/456f2d1e8f873ec05551f7e94f59a1d141970c95))
* stubs for the modules of the other work packages ([80e9c73](https://github.com/Avunu/docusystem/commit/80e9c739413627caed4d0ca10a891cc29b348104))


### Bug Fixes

* a ${...} in a page, a title or a config text can no longer run code in the build ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* bound the symlink walk, compare refused folder names without case, refuse empty option values ([afdbedc](https://github.com/Avunu/docusystem/commit/afdbedc9e8b961b496083edee6ad15a0be4adfe8))
* **catalog:** refuse template expressions and markup in the project catalog ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* document docusystem jx build as the debugging example, not jx validate ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* init patches the author-form and folded auto-merge conditions; doctor names init only when it can ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* keep the package out of a converted Dependabot cooldown and refresh stale comments ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* keep the shared workflows' pin updates out of Dependabot auto-merge ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* launch the docs sites after avunu.net, or accept a dead Projects menu ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* make the jx fragment example take effect and count the fragment as an override ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* migrate repositories that copied the earlier starter ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* name the page and the cause when a raw HTML anchor fails a lenient build ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* name the real Markdown folder in lint and navigation messages ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* pass the Windows unit tests (LF checkout, platform-aware tests) ([#39](https://github.com/Avunu/docusystem/issues/39)) ([e33c8a7](https://github.com/Avunu/docusystem/commit/e33c8a7c40cf0201f6131b471c6acf9e2a5a6846))
* refuse script-carrying Markdown on the published site, and give every page a Content-Security-Policy ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* report an anchor with an href in a paragraph as a lint error ([#19](https://github.com/Avunu/docusystem/issues/19)) ([744e630](https://github.com/Avunu/docusystem/commit/744e630805cf0e6471c44e61a048151784e70458))
* stage raw HTML links and images to repository files ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* treat domain verification as the takeover control and document retiring a site ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* write init's files so that the adopting repository's formatter accepts them ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
* write the page title escaped, so a title cannot put markup in the head ([c344ff1](https://github.com/Avunu/docusystem/commit/c344ff1bd698b9409e9d4d7c5f1fc3afbf40ceeb))
