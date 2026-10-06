// The Content-Security-Policy of the pages (the third layer of html-policy.ts): a `<meta>` that the
// post-build step puts first in the head of every page, built from the page itself.
//
// What it does for a documentation site whose pages come from other people's Markdown:
//   - scripts run only from the site's own files (`'self'`) or are the inline scripts that the build
//     wrote, named by their hash: an event-handler attribute, a `javascript:` address and a script that
//     somebody wrote into the Markdown are all refused by the browser, whatever slipped past the lint;
//   - nothing is embedded (`frame-src`, `object-src`), the base address cannot be changed
//     (`base-uri`) and no form can be sent anywhere (`form-action`);
//   - the page talks only to itself and to the project catalog of avunu.net (the project switcher), and
//     loads fonts from itself and images from itself and from any https site (a page may show the
//     badge of its repository).
// Styles keep `'unsafe-inline'`: the pages carry `<style>` blocks. A `<meta>` policy cannot set
// `frame-ancestors`, which GitHub Pages cannot send as a header either.
//
// A page that already has a policy keeps it: the browser enforces every policy it finds, so another
// one (a layout of the project) can only narrow this one.
import { createHash } from "node:crypto";
import { type Tag, tokens } from "./html-policy.js";

/** Marks the meta this module wrote, so that running the step again replaces it. */
const MARKER = "data-docusystem-csp";

/** The origin that the project switcher fetches the live catalog from. */
const CATALOG_ORIGIN = "https://avunu.net";

const attribute = (tag: Tag, name: string): string | undefined =>
  tag.attributes.find((a) => a.name === name)?.value;

/** The MIME types and keywords that make a `<script>` run (or, for an import map, configure running). */
const EXECUTABLE =
  /^(?:|module|importmap|speculationrules|(?:application|text)\/(?:javascript|ecmascript|x-javascript|x-ecmascript|jscript|livescript))$/i;

/** The text of each inline script of a page that a browser would run: no `src`, an executable type. */
export function inlineScripts(html: string): string[] {
  const found: string[] = [];
  for (const token of tokens(html)) {
    if (token.kind !== "tag" || token.closing || token.name !== "script") continue;
    if (token.body === undefined || attribute(token, "src") !== undefined) continue;
    if (!EXECUTABLE.test((attribute(token, "type") ?? "").trim())) continue;
    found.push(html.slice(token.body.start, token.body.end));
  }
  return found;
}

/** `'sha256-...'`, the form a policy names an inline script by. */
export function scriptHash(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** The policy for a page whose inline scripts are `scripts`. */
export function policyFor(scripts: string[]): string {
  const hashes = [...new Set(scripts.map(scriptHash))];
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https:",
    "font-src 'self'",
    `connect-src 'self' ${CATALOG_ORIGIN}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * `html` with the policy meta first in its head (after the `<meta charset>`, which has to stay within
 * the first 1,024 bytes), replacing one that this function wrote before. A page with no `<head>` is
 * returned as it is; the assertions report it.
 */
export function withContentSecurityPolicy(html: string): string {
  let page = html;
  for (const token of tokens(page).reverse()) {
    if (token.kind === "tag" && token.name === "meta" && attribute(token, MARKER) !== undefined) {
      page = page.slice(0, token.start) + page.slice(token.end);
    }
  }
  const all = tokens(page);
  const head = all.find((t): t is Tag => t.kind === "tag" && !t.closing && t.name === "head");
  if (head === undefined) return page;
  let at = head.end;
  const first = all.find((t) => t.start >= head.end);
  if (
    first?.kind === "tag" &&
    first.start === head.end &&
    first.name === "meta" &&
    attribute(first, "charset") !== undefined
  ) {
    at = first.end;
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policyFor(inlineScripts(page))}" ${MARKER}>`;
  return page.slice(0, at) + meta + page.slice(at);
}

/** The directives of a policy: name (lower case) to its source list. */
function directivesOf(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name !== undefined && name !== "" && !out.has(name.toLowerCase())) {
      out.set(name.toLowerCase(), sources);
    }
  }
  return out;
}

/** Sources that let a script come from anywhere or run from the page unnamed. */
const OPEN_SOURCE =
  /^(?:'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'|\*|data:|blob:|https?:|https?:\/\/.*)$/i;

/**
 * What is wrong with the policy of a built page, as sentences (none for a file that has no `<head>`):
 * no policy, one that comes after a script or other resource, one that lets scripts run from anywhere, embed pages or send forms, or one
 * that does not name an inline script of the page.
 */
export function policyProblems(html: string): string[] {
  const all = tokens(html);
  // A file without a head (a verification file of public/, say) is not a page the policy can govern.
  if (!all.some((t) => t.kind === "tag" && !t.closing && t.name === "head")) return [];
  const metas = all.filter(
    (t): t is Tag =>
      t.kind === "tag" &&
      !t.closing &&
      t.name === "meta" &&
      attribute(t, "http-equiv")?.trim().toLowerCase() === "content-security-policy",
  );
  if (metas.length === 0) return ["it has no Content-Security-Policy meta"];
  const problems: string[] = [];
  const first = metas[0]!;
  const early = all.find(
    (t) =>
      t.kind === "tag" &&
      !t.closing &&
      ["script", "link", "style", "img", "iframe", "object", "embed"].includes(t.name) &&
      t.start < first.start,
  );
  if (early !== undefined) {
    problems.push(
      `its Content-Security-Policy comes after a <${(early as Tag).name}>, which it cannot govern`,
    );
  }
  const policy = directivesOf(attribute(first, "content") ?? "");
  const scripts = policy.get("script-src") ?? policy.get("default-src");
  if (scripts === undefined) {
    problems.push("its Content-Security-Policy has no script-src");
  } else {
    const open = scripts.filter((s) => OPEN_SOURCE.test(s));
    if (open.length > 0) problems.push(`script-src allows ${open.join(" ")}`);
    for (const script of new Set(inlineScripts(html))) {
      if (!scripts.includes(scriptHash(script))) {
        problems.push(
          `an inline script (${script.trim().slice(0, 30).replaceAll(/\s+/g, " ")}...) is not named by its hash`,
        );
      }
    }
  }
  for (const directive of ["object-src", "base-uri", "form-action", "frame-src"]) {
    const sources = policy.get(directive);
    if (sources === undefined && !(directive === "frame-src" && policy.has("default-src"))) {
      problems.push(`its Content-Security-Policy has no ${directive}`);
    } else if (sources?.some((s) => s === "*" || /^https?:/i.test(s))) {
      problems.push(`${directive} allows ${sources.join(" ")}`);
    }
  }
  return problems;
}
