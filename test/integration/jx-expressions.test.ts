// `${...}` in a documentation file must never run in the build. Jx evaluates every string that holds
// `${` with `new Function`, in its own process, with the user's privileges, and its Markdown parser
// makes only the text of a page inert, not what becomes an attribute (a link address, an autolink, a
// URL, raw HTML, a directive, the language of a fence) and not the strings that the layouts hand to
// components as props (a folder's title, a name). So a pull request that touches only docs/ was code.
//
// Every attack shape below is built with the REAL pipeline and the REAL pinned Jx. Each one tries to
// create a file named PWNED_<n> in Jx's working directory; none may exist afterwards, in a strict
// build and in a lenient one. Without the fix the same tree creates all of them (verified when the
// fix was written). The seeded random corpus is in jx-expressions-fuzz.test.ts.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../support/index.js";
import { restoreText } from "../../src/lib/inert.js";
import { jxEnv, repoFrom, type Repo } from "./support.js";

const ZWSP = String.fromCodePoint(0x200b);

/** The expression of vector `n`: creates `PWNED_<n>` (a file) in the working directory of Jx. */
const expr = (n: number, quote = "'"): string =>
  `\${process.getBuiltinModule(${quote}fs${quote}).writeFileSync(${quote}PWNED_${n}${quote},${quote}${quote})}`;

/** The same for vector `n`, written with template literals and mkdir: the finding's own shape. */
const literal = (n: number): string =>
  `\${process.getBuiltinModule(\`fs\`).mkdirSync(\`PWNED_${n}\`)}`;

const FRONTMATTER = "---\ntitle: Vectors\n---\n\n";

/** [vector, Markdown]: each in its own block of the page `docs/vectors.md`. */
const VECTORS: Array<[number, string]> = [
  [1, `[a](https://example.com/${expr(1)})`],
  [2, `[a](<https://example.com/${expr(2)}>)`],
  [3, `![a](https://example.com/${expr(3)}.png)`],
  [4, `<https://example.com/${expr(4)}>`],
  [5, `A bare address https://example.com/${expr(5)} in a sentence.`],
  [6, `A bare address www.example.com/${expr(6)} in a sentence.`],
  [7, `<iframe src="https://example.com/${expr(7)}"></iframe>`],
  [8, `<div data-a="${expr(8)}">text</div>`],
  [9, `<img src='${expr(9, '"')}' alt="x">`],
  // the spellings that Markdown decodes before Jx sees them
  [10, `[a](https://example.com/&#36;{${expr(10).slice(2)})`],
  [11, `[a](https://example.com/$\\{${expr(11).slice(2)})`],
  [12, `[a](https://example.com/&dollar;&lbrace;${expr(12).slice(2)})`],
  [13, `<img src="&#x24;&#x7B;${expr(13).slice(2)}" alt="x">`],
  // other places a link can stand
  [14, `| Column | Other |\n| --- | --- |\n| [a](https://example.com/${expr(14)}) | b |`],
  [15, `- an item with [a](https://example.com/${expr(15)})`],
  [16, `> [!NOTE]\n> [a](https://example.com/${expr(16)})`],
  [17, `## [a](https://example.com/${expr(17)})`],
  // attributes of a directive, the language of a fence
  [18, `:::note{class='${expr(18, '"')}'}\nbody\n:::`],
  [19, `::leaf{key='${expr(19, '"')}'}`],
  [20, `\`\`\`${expr(20)}\ncode\n\`\`\``],
  [21, `\`\`\`js ${expr(21)}\ncode\n\`\`\``],
  [22, `~~~${expr(22)}\ncode\n~~~`],
  // the finding's own shape: template literals and backticks inside an address
  [23, `[link](<https://example.com/${literal(23)}>)`],
  [24, `[link](https://example.com/\`${expr(24)}\`)`],
  // code spans and fences that CommonMark does not read as code, placed to hide an expression
  [25, `A tick \` opens here\nand \` then [a](https://example.com/${expr(25)}) and \``],
  [26, `<img alt="a"\n     src="https://example.com/${expr(26)}">`],
  [27, `<a title="\`">[a](https://example.com/${expr(27)})\``],
  [28, `| \`a | [b](https://example.com/${expr(28)}) | c\` |\n| --- | --- | --- |`],
  [29, `A paragraph line\n    \`\`\`js\n[a](https://example.com/${expr(29)})`],
  [30, `> \`\`\`\nnot quoted\n[a](https://example.com/${expr(30)})\n\`\`\``],
  [31, `<div>\n\`\`\`\n<img src="${expr(31, "'")}" alt="x">\n\`\`\`\n</div>`],
  [32, `- item\n  \`\`\`\n  code\ndedented [a](https://example.com/${expr(32)})\n  \`\`\``],
  [33, `[ref]: https://example.com/${expr(33)}`],
  [36, `Code \`first\` and then <img src="${expr(36)}" alt="x">`],
  [37, `[a](<https://example.com/x) ${literal(37)} y>)`],
];

/** The vectors that the line-by-line lint does not report (they are neutralized all the same). */
const UNREPORTED: number[] = [25, 26, 28, 29, 30, 31, 32];

/** What must still read as it was written: code. */
const CODE = [
  "Inline `${HOME}` stays.",
  "```bash\necho ${HOME} and ${{ secrets.TOKEN }}\n```",
  "1. A step:\n\n   ```yaml\n   run: echo ${{ github.sha }}\n   ```",
  "> [!TIP]\n> ```bash\n> export HOME_COPY=${HOME}\n> ```",
  "| Variable | Meaning |\n| --- | --- |\n| `${HOME}` | Home folder |",
  "See [the guide](guide/install.md) for `${PORT}`.",
];

function cli(repo: Repo, argv: string[], env: NodeJS.ProcessEnv = {}) {
  return runCli(argv, { cwd: repo.siteDir, env: jxEnv(env) });
}

/** The marker files of every vector that ran, in the working directory of Jx. */
const ran = (repo: Repo): string[] =>
  existsSync(repo.paths.root)
    ? readdirSync(repo.paths.root).filter((name) => name.startsWith("PWNED_"))
    : [];

function write(repo: Repo, path: string, text: string): void {
  const file = join(repo.dir, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function vectorsRepo(): Repo {
  const repo = repoFrom("canary/clean");
  write(
    repo,
    "docs/vectors.md",
    FRONTMATTER + VECTORS.map(([, markdown]) => markdown).join("\n\n") + "\n",
  );
  write(repo, "docs/code.md", `---\ntitle: Code\n---\n\n${CODE.join("\n\n")}\n`);
  // a line of frontmatter that looks like the start of a fence must not hide the page that follows
  write(
    repo,
    "docs/frontmatter.md",
    `---\ntitle: Frontmatter\nnote: |\n  \`\`\`\n---\n\n[a](https://example.com/${expr(38)})\n`,
  );
  return repo;
}

describe("`${...}` in the Markdown of a page", () => {
  test("lenient build: no vector runs, and the build still succeeds", async () => {
    const repo = vectorsRepo();
    const { code, stdout, stderr } = await cli(repo, ["build", "--lenient"]);
    expect(ran(repo), `${stdout}\n${stderr}`).toEqual([]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  });

  test("strict build: no vector runs, and the build fails naming every place a link or a tag held one", async () => {
    const repo = vectorsRepo();
    const { code, stdout, stderr } = await cli(repo, ["build"], { CI: "true" });
    const all = `${stdout}\n${stderr}`;
    expect(ran(repo), all).toEqual([]);
    expect(code, all).toBe(1);
    expect(existsSync(repo.paths.dist)).toBe(false);
    const text = readFileSync(join(repo.docsDir, "vectors.md"), "utf8").split("\n");
    const unreported = VECTORS.filter(([n]) => {
      const line = text.findIndex((l) => l.includes(`PWNED_${n}`)) + 1;
      return !new RegExp(
        `lint: error: .*vectors\\.md:${line}  A \\$\\{\\.\\.\\.\\} in a link address`,
      ).test(all);
    }).map(([n]) => n);
    // The lint reads one line at a time and is only a report. These shapes need a CommonMark parse to
    // tell that the expression is live, so they are made inert without a word.
    expect(unreported).toEqual(UNREPORTED);
  });

  test("the address is kept, with the expression written inert", async () => {
    const repo = vectorsRepo();
    expect((await cli(repo, ["build", "--lenient"])).code).toBe(0);
    const page = readFileSync(join(repo.paths.dist, "docs", "vectors", "index.html"), "utf8");
    // href, src and attribute values hold the text with a zero-width space between `$` and `{`
    expect(page).toContain(`href="https://example.com/$${ZWSP}{process.getBuiltinModule(`);
    expect(page).toContain(`data-a="$${ZWSP}{process.getBuiltinModule(`);
    expect(page).not.toMatch(/\$\{process\.getBuiltinModule/);
  });

  test("prose and code read as written: `${` is back in every text node, and only attributes keep the marker", async () => {
    const repo = vectorsRepo();
    expect((await cli(repo, ["build", "--lenient"])).code).toBe(0);
    // staging wrote the marker, in code too
    const staged = readFileSync(join(repo.paths.root, ".generated", "docs", "code.md"), "utf8");
    expect(staged).toContain(`\`$${ZWSP}{HOME}\``);
    const page = readFileSync(join(repo.paths.dist, "docs", "code", "index.html"), "utf8");
    // the body of the page: the code as it was written (a highlighted block is split into tokens)
    const body = page.slice(page.indexOf("<docs-prose"), page.indexOf("</docs-prose>"));
    expect(body).toContain("<code>&#36;{HOME}</code>");
    const text = body
      .replaceAll(/<[^>]*>/g, "")
      .replaceAll("&#36;", "$")
      .replaceAll("&amp;", "&");
    expect(text).toContain("echo ${HOME} and ${{ secrets.TOKEN }}");
    expect(text).toContain("run: echo ${{ github.sha }}");
    expect(text).toContain("export HOME_COPY=${HOME}");
    expect(text).toContain("${PORT}");
    expect(body).not.toContain(ZWSP);
    // and the text of the vector page too
    const vectors = readFileSync(join(repo.paths.dist, "docs", "vectors", "index.html"), "utf8");
    expect(restoreText(vectors)).toBe(vectors);
  });

  test("a vector page does not make the clean pages worse", async () => {
    const repo = vectorsRepo();
    expect((await cli(repo, ["build", "--lenient"])).code).toBe(0);
    const clean = readFileSync(
      join(repo.paths.dist, "docs", "guide", "install", "index.html"),
      "utf8",
    );
    expect(clean).not.toContain(ZWSP);
  });
});

describe("`${...}` where a title or a name becomes a label", () => {
  test("the title of a folder's README, a folder name and a heading with code in it do not run (the header's search links are props)", async () => {
    const repo = repoFrom("canary/clean");
    write(
      repo,
      "docs/by-title/README.md",
      `---\ntitle: "Section ${expr(40)}"\n---\n\nA section whose title is an expression.\n`,
    );
    write(
      repo,
      "docs/by-heading/README.md",
      `# Using \`${expr(41)}\`\n\nA section whose heading holds an expression in a code span.\n`,
    );
    write(
      repo,
      `docs/by-name-${expr(42)}/page.md`,
      "---\ntitle: Page\n---\n\nA folder whose name is an expression.\n",
    );
    write(
      repo,
      "docs/loose.md",
      `---\ntitle: Loose\nnav_title: "Label ${expr(43)}"\ndescription: "Text ${expr(44)}"\n---\n\nA page.\n`,
    );
    for (const argv of [["build", "--lenient"], ["build"]]) {
      const { stdout, stderr } = await cli(repo, argv, argv.length === 1 ? { CI: "true" } : {});
      expect(ran(repo), `${stdout}\n${stderr}`).toEqual([]);
    }
    const page = readFileSync(join(repo.paths.dist, "docs", "loose", "index.html"), "utf8");
    // the label is still there, as text
    expect(page).toContain("Label &#36;{process.getBuiltinModule");
  });
});

describe("`${...}` in the configuration", () => {
  const config = (extra: Record<string, unknown>) => (repo: Repo) =>
    write(
      repo,
      "docs-site/docusystem.config.json",
      JSON.stringify({
        ...JSON.parse(readFileSync(join(repo.siteDir, "docusystem.config.json"), "utf8")),
        ...extra,
      }),
    );

  for (const key of ["name", "tagline", "license"]) {
    test(`${key}: refused before anything is built`, async () => {
      const repo = repoFrom("canary/clean");
      config({ [key]: `Safe ${expr(50)}` })(repo);
      const { code, stdout, stderr } = await cli(repo, ["build", "--lenient"]);
      expect(code).toBe(1);
      expect(`${stdout}\n${stderr}`).toContain(`"${key}" must not contain \${...}`);
      expect(existsSync(repo.paths.root)).toBe(false);
    });
  }
});
