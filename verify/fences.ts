// Proves that every fenced code block of the Markdown comes out of the build with exactly its text:
// the highlighter, the emitter and the whitespace fixes must neither lose nor add a character.
//
//   bun fences.ts <site folder or Jx root>
//
// Takes the docs-site folder of a built project, or the assembled Jx root inside it
// (`<site>/.docusystem/site`). Reads the sidebar data the build generated (`.generated/nav.json`), the
// Markdown in the folder the resolved configuration names (`docsPath`, relative to the repository root,
// which is the nearest folder above that has a `.git`) and the pages the build wrote (`dist/`).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const given = resolve(process.argv[2] ?? ".");
const root = existsSync(join(given, ".generated", "nav.json"))
  ? given
  : join(given, ".docusystem", "site");
if (!existsSync(join(root, ".generated", "nav.json"))) {
  console.error(`fences: ${given} has not been built (no .generated/nav.json); run docusystem check first`);
  process.exit(2);
}
const nav = JSON.parse(readFileSync(join(root, ".generated", "nav.json"), "utf8")) as {
  pages: Record<string, { edit: string }>;
};
const config = JSON.parse(readFileSync(join(root, "docusystem.config.json"), "utf8")) as {
  docsPath: string;
};
let repoRoot = dirname(given);
while (!existsSync(join(repoRoot, ".git")) && dirname(repoRoot) !== repoRoot) {
  repoRoot = dirname(repoRoot);
}
const docs = join(repoRoot, config.docsPath);

const decode = (html: string) =>
  html
    .replaceAll(/<[^>]+>/g, "")
    .replaceAll(/&#x([0-9a-f]+);/gi, (_m, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replaceAll(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

/** The text of each fenced block of a Markdown source, in order. */
export function fencesOf(markdown: string): string[] {
  const out: string[] = [];
  const lines = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split(/\r?\n/);
  const quotePrefix = /^((?:\s*>)+ ?)/;
  let open: { fence: string; indent: number; quoted: boolean; text: string[] } | null = null;
  for (const raw of lines) {
    // A blockquote prefix is only markup when the block started inside the quote; in a block of its own a leading ">" is code.
    const quote = quotePrefix.exec(raw);
    const stripped = quote ? raw.slice(quote[0].length) : raw;
    if (open) {
      const line = open.quoted ? stripped : raw;
      const close = new RegExp(
        `^\\s{0,3}${open.fence[0] === "`" ? "`" : "~"}{${open.fence.length},}\\s*$`,
      );
      if (close.test(line)) {
        out.push(open.text.join("\n"));
        open = null;
      } else {
        open.text.push(line.replace(new RegExp(`^ {0,${open.indent}}`), ""));
      }
      continue;
    }
    const start = /^(\s*)(`{3,}|~{3,})([^`]*)$/.exec(stripped);
    if (start)
      open = { fence: start[2]!, indent: start[1]!.length, quoted: quote !== null, text: [] };
  }
  return out;
}

let checked = 0;
let bad = 0;
for (const [url, info] of Object.entries(nav.pages)) {
  const source = readFileSync(join(docs, info.edit), "utf8");
  const wanted = fencesOf(source);
  const file = join(root, "dist", url.replace(/^\//, ""), "index.html");
  if (!existsSync(file)) continue;
  const built = [
    ...readFileSync(file, "utf8").matchAll(
      /<pre><code[^>]*>([\s\S]*?)<\/code>(?:<button[\s\S]*?<\/button>)?<\/pre>/g,
    ),
  ].map((m) => decode(m[1]!));
  if (built.length !== wanted.length) {
    bad++;
    console.log(
      `MISMATCH ${url}: the source has ${wanted.length} code block(s), the page ${built.length}`,
    );
    continue;
  }
  wanted.forEach((text, i) => {
    checked++;
    const want = text.replace(/\n+$/, "");
    const got = built[i]!.replace(/\n+$/, "");
    if (want !== got) {
      bad++;
      const at = [...want].findIndex((c, k) => c !== got[k]);
      console.log(
        `MISMATCH ${url} block ${i + 1}: differs at character ${at}: wanted ${JSON.stringify(want.slice(Math.max(0, at - 20), at + 30))}, got ${JSON.stringify(got.slice(Math.max(0, at - 20), at + 30))}`,
      );
    }
  });
}
console.log(`fences: ${checked} code block(s) compared, ${bad} difference(s)`);
process.exit(bad === 0 ? 0 : 1);
