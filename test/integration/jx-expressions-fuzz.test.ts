// The seeded random corpus for jx-expressions.test.ts: pages built from the shapes that make a line
// scanner and CommonMark disagree about what is code (fences indented and quoted and nested in lists,
// backticks that pair across lines or sit inside a tag, tags and links that do not close, tables,
// raw HTML blocks, frontmatter that looks like a fence, directives, escapes, CRLF), each carrying
// expressions in places where Jx would evaluate them. The REAL pipeline and the REAL Jx build all of
// the pages in one run; every expression writes a file named after its page and its number, and the
// test fails if any exists. Whatever the shapes make of a page, nothing may run.
//
// A failure names the page and the expression; the page is in the failure message. The corpus is
// deterministic (the seed is fixed), so a failure is reproducible. DOCUSYSTEM_FUZZ_DOCS and
// DOCUSYSTEM_FUZZ_SEED widen the search while developing.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { runCli } from "../support/index.js";
import { jxEnv, repoFrom } from "./support.js";

/** mulberry32: a small seeded generator, so that the corpus is the same on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOCS = Number(process.env.DOCUSYSTEM_FUZZ_DOCS ?? 150);
const SEED = Number(process.env.DOCUSYSTEM_FUZZ_SEED ?? 20261006);

/** The expression that records that it ran: a file `PWNED_<id>` in the working directory of Jx. */
const run = (id: string, quote: string): string =>
  `process.getBuiltinModule(${quote}fs${quote}).writeFileSync(${quote}PWNED_${id}${quote},${quote}${quote})`;

type Make = (id: string) => string;

/** Places where Jx evaluates `${...}`: every one of them must end up inert. */
const PAYLOADS: Make[] = [
  (id) => `[a](https://example.com/\${${run(id, "'")}})`,
  (id) => `[a](<https://example.com/\${${run(id, "'")}}>)`,
  (id) => `![a](https://example.com/\${${run(id, "'")}}.png)`,
  (id) => `<https://example.com/\${${run(id, "'")}}>`,
  (id) => `https://example.com/\${${run(id, "'")}}`,
  (id) => `www.example.com/\${${run(id, "'")}}`,
  (id) => `<img src="\${${run(id, "'")}}" alt="x">`,
  (id) => `<div data-a="\${${run(id, "'")}}">text</div>`,
  (id) => `<span title="a" data-b='\${${run(id, '"')}}'>text</span>`,
  (id) => `[a](https://example.com/&#36;{${run(id, "'")}})`,
  (id) => `[a](https://example.com/$\\{${run(id, "'")}})`,
  (id) => `<img src="&dollar;&lbrace;${run(id, "'")}}" alt="x">`,
  (id) => `[a](https://example.com/\${${run(id, "'")}} "a title")`,
  (id) => `| [a](https://example.com/\${${run(id, "'")}}) | b |`,
  (id) => `- [a](https://example.com/\${${run(id, "'")}})`,
  (id) => `> [a](https://example.com/\${${run(id, "'")}})`,
  (id) => `## [a](https://example.com/\${${run(id, "'")}})`,
  (id) => `<img alt="a"\n     src="\${${run(id, "'")}}">`,
  (id) => `:::note{class='\${${run(id, '"')}}'}\ntext\n:::`,
  (id) => `::leaf{key='\${${run(id, '"')}}'}`,
  (id) => `[a](<https://example.com/x) \${${run(id, "`")}} y>)`,
  (id) => `[link](<https://example.com/\${${run(id, "`")}}>)`,
];

/** Shapes that make a scanner and CommonMark disagree about what is code. */
const HIDERS: Array<() => string> = [
  () => "text `",
  () => "`",
  () => "``",
  () => "```",
  () => "```js",
  () => "~~~",
  () => "````",
  () => " ```",
  () => "  ```",
  () => "   ```",
  () => "    ```",
  () => "     ```",
  () => "\t```",
  () => "> ```",
  () => ">```js",
  () => "> > ```",
  () => "- item\n  ```",
  () => "1. item\n   ```",
  () => "10. item\n    ```",
  () => "- item\n\n      ```",
  () => "* item\ndedent",
  () => "<div>",
  () => "<details>",
  () => "<details><summary>s</summary>",
  () => "<!--",
  () => "-->",
  () => "<pre>",
  () => "</pre>",
  () => "<script>",
  () => "<style>",
  () => "<p>",
  () => "<custom-el>",
  () => '<img alt="',
  () => '<a title="`">',
  () => "<a title='`'>",
  () => "<!-- ` -->",
  () => "<br> `",
  () => "| `a | b` |",
  () => "| a | b |\n| --- | --- |",
  () => "| `a` | `b` |",
  () => "[x](",
  () => "](",
  () => "[x](<",
  () => "[x](<a b>)",
  () => "[x](a (b) c)",
  () => ":::x{",
  () => "::y{a='",
  () => ":z[label]{",
  () => "`${HOME}`",
  () => "```bash\necho ${HOME}\n```",
  () => "---",
  () => "===",
  () => "\\`",
  () => "\\<",
  () => "\\[",
  () => "&#96;",
  () => "    ",
  () => "\t",
  () => "text with <b>inline</b> html",
  () => "[ref]: https://example.com/",
  () => "Setext\n-----",
];

const FRONTMATTERS = [
  "---\ntitle: T\n---\n\n",
  "---\ntitle: T\nnote: |\n  ```\n---\n\n",
  "---\ntitle: T\nnote: |\n  ~~~\n---\n",
  "---\ntitle: T\n---\n",
  "﻿---\ntitle: T\n---\n\n",
  "---   \ntitle: T\n---   \n\n",
];

function page(next: () => number, doc: number): { text: string; ids: string[] } {
  const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
  const ids: string[] = [];
  const pieces: string[] = [];
  const count = 3 + Math.floor(next() * 12);
  for (let at = 0; at < count; at++) {
    const roll = next();
    if (roll < 0.28) {
      const id = `${doc}_${ids.length}`;
      ids.push(id);
      pieces.push(pick(PAYLOADS)(id));
    } else {
      pieces.push(pick(HIDERS)());
    }
  }
  if (ids.length === 0) {
    const id = `${doc}_0`;
    ids.push(id);
    pieces.push(pick(PAYLOADS)(id));
  }
  let body = pieces[0]!;
  for (const piece of pieces.slice(1)) {
    const roll = next();
    body += (roll < 0.65 ? "\n" : roll < 0.95 ? "\n\n" : " ") + piece;
  }
  let text = pick(FRONTMATTERS) + body + "\n";
  if (next() < 0.1) text = text.replaceAll("\n", "\r\n");
  return { text, ids };
}

test(`${DOCS} generated pages (seed ${SEED}): nothing runs, in a lenient build`, async () => {
  const repo = repoFrom("canary/clean");
  const next = random(SEED);
  const source = new Map<string, string>();
  for (let doc = 0; doc < DOCS; doc++) {
    const { text, ids } = page(next, doc);
    const file = join(repo.docsDir, "fuzz", `p${doc}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    for (const id of ids) source.set(id, `docs/fuzz/p${doc}.md\n${JSON.stringify(text)}`);
  }
  const { stdout, stderr } = await runCli(["build", "--lenient"], {
    cwd: repo.siteDir,
    env: jxEnv(),
  });
  // Jx must have run: the clean pages' output is the evidence (the run may still fail on its own terms)
  expect(existsSync(repo.paths.root), `${stdout}\n${stderr}`).toBe(true);
  expect(existsSync(join(repo.paths.root, "dist", "index.html")), `${stdout}\n${stderr}`).toBe(
    true,
  );
  const ran = readdirSync(repo.paths.root)
    .filter((name) => name.startsWith("PWNED_"))
    .map((name) => name.slice("PWNED_".length));
  expect(
    ran.map((id) => `${id}: ${source.get(id)}`),
    "pages whose expression ran",
  ).toEqual([]);
}, 600_000);
