// The safety assertions of step 12 (the second layer of html-policy.ts): they read what Jx wrote and
// refuse a site whose pages could run somebody else's code, whatever put it there. Markdown is passed
// to the page nearly as it is: raw HTML, link and image addresses, directive attributes (`:script[...]`,
// `::div{innerHTML=...}`) and every file a page links to from the Markdown folder arrive in `dist`
// unchecked by Jx, and the lint (unsafe-markup.ts) reads only what the author wrote, not what came out.
// Like every assertion these are fatal in every mode: a build that fails one publishes nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { policyProblems } from "./csp.js";
import {
  ACTIVE_EXTENSIONS,
  extensionOf,
  pageHazards,
  svgHazards,
  xmlHazards,
} from "./html-policy.js";
import type { Assertion } from "./types.js";
import { fail, listOf, pass } from "./verdict.js";

/** How many items of a list a message of this module names. */
const SHOWN = 4;

/** The folder Jx copies the files that a page links to from the Markdown folder into: `/content/<collection>/...`. */
const CONTENT_FOLDER = "content/";

/**
 * What makes a file under `content/` active when a browser opens it from the site's own domain, as
 * short phrases (nothing for a picture, a PDF, an archive or a data file). `text` reads a text file.
 */
function activeFile(file: string, text: () => string): string[] {
  const extension = extensionOf(file);
  if (ACTIVE_EXTENSIONS.has(extension))
    return [`a .${extension} file, which a browser opens as a page or runs`];
  if (extension === "svg") return svgHazards(text());
  if (extension === "xml") return xmlHazards(text());
  return [];
}

/**
 * The assertions of this module for a built site: `files` are the paths under `dist`, `pages` its HTML
 * pages (route and text). Three assertions, always in this order: the pages hold nothing that runs
 * code, the files from the Markdown folder are not active, every page has its policy.
 */
export function safetyAssertions(
  dist: string,
  files: Set<string>,
  pages: Array<{ route: string; html: string }>,
): Assertion[] {
  const out: Assertion[] = [];

  const hazardous = pages.flatMap(({ route, html }) => {
    const found = pageHazards(html);
    return found.length > 0 ? [`${route} (${listOf(found, 2)})`] : [];
  });
  out.push(
    hazardous.length === 0
      ? pass("no page holds a script, an event handler, a javascript: address or an embedded page")
      : fail(
          `pages hold something that runs code or embeds another page: ${listOf(hazardous, SHOWN)}. It comes from raw HTML, a link, an image or a :directive in the Markdown, which may only use text, table and image elements and http, https, mailto, tel and relative addresses (docusystem lint names the file and line)`,
        ),
  );

  const active = [...files]
    .filter((file) => file.startsWith(CONTENT_FOLDER))
    .flatMap((file) => {
      const found = activeFile(file, () => readFileSync(join(dist, ...file.split("/")), "utf8"));
      return found.length > 0 ? [`/${file} (${listOf(found, 2)})`] : [];
    });
  out.push(
    active.length === 0
      ? pass(
          "every file published from the Markdown folder is a picture, a document or data, none runs",
        )
      : fail(
          `files linked from the Markdown would run on the site's domain when opened: ${listOf(active, SHOWN)}. Link to images, PDFs and archives only; an HTML, script or XML page cannot be published from the documentation`,
        ),
  );

  // A page under /content/ is a file of the Markdown folder, not a page of the site: the assertion above reports it.
  const unguarded = pages.flatMap(({ route, html }) => {
    const found = route.startsWith(`/${CONTENT_FOLDER}`) ? [] : policyProblems(html);
    return found.length > 0
      ? [`${route} (${found[0]}${found.length > 1 ? ` and ${found.length - 1} more` : ""})`]
      : [];
  });
  out.push(
    unguarded.length === 0
      ? pass(
          `${pages.length} page${pages.length === 1 ? "" : "s"} carry a Content-Security-Policy that blocks inline handlers, javascript: addresses and scripts the build did not write`,
        )
      : fail(`pages without a sound Content-Security-Policy: ${listOf(unguarded, SHOWN)}`),
  );
  return out;
}
