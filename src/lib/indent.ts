// How the JSON files that `init` writes (docs-site/docusystem.config.json and package.json) should be
// indented, so that they pass the adopting repository's own formatter check (`oxfmt --check`,
// `prettier --check`). A repository that formats with tabs fails a pull request that adds two
// files indented with two spaces.
//
// The answer is read, never guessed from a tool that is not there:
//   1. the formatter configuration at the repository root (`useTabs`, `tabWidth`), which overrides
//   2. the root `.editorconfig` (`indent_style`, `indent_size`, `tab_width`), which oxfmt and prettier
//      both read when their own configuration is silent;
//   3. failing both, the indentation of the repository's own root package.json;
//   4. failing that, two spaces.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** What `JSON.stringify` takes as its third argument: a tab, or a count of spaces. */
export type Indent = "\t" | number;

/** Formatter configurations that can be read as data (a `.js` or `.ts` one cannot be). */
const FORMATTER_DATA = [
  ".oxfmtrc.json",
  ".oxfmtrc.jsonc",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The indentation of a JSON text: its first indented line; null when it has none. */
export function indentOf(text: string): "\t" | number | null {
  const lead = /^([ \t]+)\S/m.exec(text)?.[1];
  if (lead === undefined) return null;
  return lead.startsWith("\t") ? "\t" : lead.length;
}

/** `text` without line and block comments (outside strings) and without trailing commas. */
function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

interface Style {
  tabs?: boolean;
  width?: number;
}

const width = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 8
    ? value
    : undefined;

function fromFormatter(repoRoot: string): Style {
  for (const name of FORMATTER_DATA) {
    const file = join(repoRoot, name);
    if (!existsSync(file)) continue;
    let config: unknown;
    try {
      const text = readFileSync(file, "utf8");
      try {
        config = JSON.parse(stripJsonc(text));
      } catch {
        config = parseYaml(text);
      }
    } catch {
      continue;
    }
    if (!isRecord(config)) continue;
    const style: Style = {};
    if (typeof config.useTabs === "boolean") style.tabs = config.useTabs;
    const tabWidth = width(config.tabWidth);
    if (tabWidth !== undefined) style.width = tabWidth;
    return style;
  }
  return {};
}

/** Whether an `.editorconfig` section name covers `package.json` (so any `*.json`). */
function coversJson(section: string): boolean {
  const braces = /\{([^{}]*)\}/.exec(section);
  const alternatives =
    braces === null
      ? [section]
      : braces[1]!.split(",").map((part) => section.replace(braces[0], part));
  return alternatives.some((glob) => {
    if (glob.includes("/")) return false;
    const pattern = glob
      .replace(/[.+^$()|[\]\\]/g, "\\$&")
      .replace(/\*\*?/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${pattern}$`).test("package.json");
  });
}

function fromEditorconfig(repoRoot: string): Style {
  const file = join(repoRoot, ".editorconfig");
  if (!existsSync(file)) return {};
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const style: Style = {};
  let size: number | "tab" | undefined;
  let tabWidth: number | undefined;
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.*)\]$/.exec(line);
    if (section !== null) {
      applies = coversJson(section[1]!);
      continue;
    }
    const pair = /^([A-Za-z_]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (!applies || pair === null) continue;
    const key = pair[1]!.toLowerCase();
    const value = pair[2]!.toLowerCase();
    if (key === "indent_style") style.tabs = value === "tab";
    else if (key === "indent_size") size = value === "tab" ? "tab" : width(Number(value));
    else if (key === "tab_width") tabWidth = width(Number(value));
  }
  const spaces = size === "tab" ? tabWidth : (size ?? tabWidth);
  if (spaces !== undefined) style.width = spaces;
  return style;
}

/**
 * The indentation that the repository's formatter will accept for the JSON files `init` writes.
 * `repoRoot` is the root of the adopting repository.
 */
export function detectJsonIndent(repoRoot: string): Indent {
  const editor = fromEditorconfig(repoRoot);
  const formatter = fromFormatter(repoRoot);
  const tabs = formatter.tabs ?? editor.tabs;
  const spaces = formatter.width ?? editor.width;
  if (tabs === true) return "\t";
  if (tabs === false || spaces !== undefined) return spaces ?? 2;
  try {
    return indentOf(readFileSync(join(repoRoot, "package.json"), "utf8")) ?? 2;
  } catch {
    return 2;
  }
}
