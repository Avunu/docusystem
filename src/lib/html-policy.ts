// What a documentation page may carry: the one policy behind the Markdown lint (unsafe-markup.ts), the
// output assertions (safety.ts) and the Content-Security-Policy meta (csp.ts).
//
// The pages of a documentation site are served from the project's own domain (<project>.avunu.net),
// which is same-site with the client portal, so a script that runs on one of them is a script that runs
// next to the portal. Markdown is not a safe format on its own: Jx passes raw HTML, link and image
// targets and directive attributes through to the page as they are. A contributor's documentation pull
// request is therefore trusted to the extent that this policy checks it, in three layers:
//
//   1. the lint reads the Markdown the way GitHub's renderer would and reports each element,
//      attribute and address that the policy refuses, with its file and line (an error under strict);
//   2. the output assertions read the HTML Jx actually wrote and refuse the same things wherever they
//      came from (raw HTML, a link, a `:script[...]` directive, a file linked from a page), in every
//      mode, so a build that is not clean publishes nothing;
//   3. every page carries a Content-Security-Policy meta that blocks inline event handlers, `javascript:`
//      addresses and scripts that the build did not write, in case the first two miss something.
//
// This file is the vocabulary of those layers: a tokenizer for tags that follows the HTML tokenizer
// (so that it sees what a browser sees), the allowed elements, and the test for an address.

// ---- Character references and addresses ----

/**
 * The named references that matter in an address: the ones that can stand for a character of a
 * scheme (`javascript&colon;`), a separator or a character the URL parser removes. A name that is not
 * here is left as written; `unsafeUrl` refuses an address whose scheme position still holds one.
 */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  colon: ":",
  Tab: "\t",
  NewLine: "\n",
  plus: "+",
  period: ".",
  sol: "/",
  bsol: "\\",
  num: "#",
  quest: "?",
  semi: ";",
  comma: ",",
  lpar: "(",
  rpar: ")",
  equals: "=",
};

/**
 * Decodes character references the way an HTML parser does in an attribute value: numeric references
 * with or without the closing semicolon (`&#106avascript:` is `javascript:`), and the named references
 * of NAMED. A NUL, a surrogate or a code point past U+10FFFF becomes U+FFFD.
 */
export function decodeReferences(value: string): string {
  return value.replaceAll(
    /&(?:#(\d{1,8});?|#[xX]([\da-fA-F]{1,8});?|([A-Za-z][A-Za-z\d]{1,31});)/g,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return Object.hasOwn(NAMED, name) ? NAMED[name]! : whole;
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "�"
        : String.fromCodePoint(code);
    },
  );
}

// The URL parser strips C0 controls (U+0000 to U+001F) and spaces from both ends of an address.
// oxlint-disable-next-line no-control-regex
const URL_EDGE = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;
// oxlint-disable-next-line no-control-regex
const URL_START = /^[\u0000-\u0020]+/;

/** The schemes a documentation page may link to. Everything else (`javascript:`, `data:`, `vbscript:`, `blob:`, `file:`) is refused. */
export const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

/** The raster formats an SVG file may embed as `data:` (a picture cannot run code; an embedded SVG or HTML can). */
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i;

/**
 * Why an address must not be used on a page, or null when it may be. `raw` is the address as written
 * in the Markdown or in the attribute: references are decoded and the characters that the URL parser
 * drops are removed before the scheme is read, so `JaVa&#x09;Script:`, `&#106;avascript:` and
 * ` javascript:` are all `javascript:`. An address with no scheme (a path, `#anchor`, `?query`) is
 * relative and allowed; so are http, https, mailto and tel. `dataImages` also allows embedded rasters.
 */
export function unsafeUrl(raw: string, o: { dataImages?: boolean } = {}): string | null {
  // The URL parser strips leading and trailing C0 controls and spaces and removes tabs and line breaks anywhere.
  const url = decodeReferences(raw)
    .replace(URL_EDGE, "")
    .replaceAll(/[\t\n\r]/g, "");
  const end = url.search(/[/?#]/);
  const head = end === -1 ? url : url.slice(0, end);
  const scheme = /^([A-Za-z][A-Za-z\d+.-]*):/.exec(head)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    // No scheme: relative, unless a reference that is not decoded here could still stand for part of one.
    const rawEnd = raw.search(/[/?#]/);
    const rawHead = rawEnd === -1 ? raw : raw.slice(0, rawEnd);
    for (const m of rawHead.matchAll(/&([A-Za-z][A-Za-z\d]*);/g)) {
      if (!Object.hasOwn(NAMED, m[1]!)) return "an address with a reference that hides its scheme";
    }
    return null;
  }
  if (SAFE_SCHEMES.has(scheme)) return null;
  if (scheme === "data" && o.dataImages === true && DATA_IMAGE.test(url)) return null;
  return `${scheme}:`;
}

/** Backslash escapes and references of a Markdown link destination, as CommonMark reads them. */
export function destinationText(raw: string): string {
  return decodeReferences(raw.replaceAll(/\\([!-/:-@[-`{-~])/g, "$1"));
}

/** A value for a message: bounded, on one line. */
export function excerpt(value: string, max = 60): string {
  const flat = value.replaceAll(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---- Tokenizer ----

export interface Attribute {
  /** Lower case. */
  name: string;
  /** As written, references not decoded. */
  value: string;
}

export interface Tag {
  kind: "tag";
  /** Lower case. */
  name: string;
  closing: boolean;
  attributes: Attribute[];
  /** Offset of the `<`. */
  start: number;
  /** Offset just past the `>`. */
  end: number;
  /** For a start tag of a raw text element (`script`, `style`, ...): the offsets of its content. */
  body?: { start: number; end: number };
}

/** A CommonMark autolink (`<https://example.com>`), when the text is Markdown rather than HTML. */
export interface Autolink {
  kind: "autolink";
  url: string;
  start: number;
  end: number;
}

/** Elements whose content a browser reads as text up to the matching end tag, not as markup. */
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

const SPACE = /[\t\n\f\r ]/;
const LETTER = /[A-Za-z]/;
/** `<scheme:address>`: a CommonMark autolink. */
// oxlint-disable-next-line no-control-regex
const AUTOLINK = /<([A-Za-z][A-Za-z\d+.-]{1,31}:[^\u0000-\u0020<>]*)>/y;
/** `<name@host>`: a CommonMark e-mail autolink, which is text and not a tag. */
const EMAIL =
  /<[\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z\d](?:[A-Za-z\d-]{0,61}[A-Za-z\d])?(?:\.[A-Za-z\d](?:[A-Za-z\d-]{0,61}[A-Za-z\d])?)*>/y;

export interface ReadOptions {
  /** Markdown: `<scheme:address>` is an autolink and `<name@host>` is text. */
  autolinks?: boolean;
  /**
   * The text is a Markdown paragraph, not an HTML block: a comment, declaration, instruction, CDATA
   * section or tag that is not closed is text and hides nothing after it, as in CommonMark; an HTML
   * parser reads it to the end of the text.
   */
  inline?: boolean;
}

/**
 * What stands at the `<` at `lt`: the token (a tag or an autolink; none for a comment, a declaration,
 * an instruction, an e-mail autolink or a `<` that is only text), `end`, where the construct ends
 * (`lt + 1` for a `<` that is only text), `next`, where reading goes on (after the content of a
 * raw text element, whose offsets are on its start tag), and `scanned`, for a construct that was not
 * closed, how much text was looked at to find out (a caller that reads every `<` of a long text adds
 * these up, because they are what makes it quadratic).
 */
export function readAt(
  text: string,
  lt: number,
  o: ReadOptions = {},
): { token?: Tag | Autolink; end: number; next: number; scanned?: number } {
  const n = text.length;
  // A construct that is not closed is text in Markdown, after a look at everything up to the end of the text.
  const unclosed = { end: lt + 1, next: lt + 1, scanned: n - lt };
  const literal = { end: lt + 1, next: lt + 1 };
  const skip = (end: number) => ({ end, next: end });
  const to = (from: number, pattern: string | RegExp): number => {
    if (typeof pattern === "string") {
      const at = text.indexOf(pattern, from);
      return at === -1 ? (o.inline === true ? -1 : n) : at + pattern.length;
    }
    pattern.lastIndex = from;
    const found = pattern.exec(text);
    return found === null ? (o.inline === true ? -1 : n) : found.index + found[0].length;
  };
  const next = text[lt + 1];
  if (next === "!" || next === "?") {
    // Comments, declarations, CDATA sections and processing instructions: skipped.
    let end: number;
    if (text.startsWith("<!--", lt)) {
      if (text.startsWith("<!-->", lt)) return skip(lt + 5);
      if (text.startsWith("<!--->", lt)) return skip(lt + 6);
      end = to(lt + 4, /--!?>/g);
    } else if (next === "?") {
      end = to(lt + 2, o.inline === true ? "?>" : ">");
    } else if (o.inline === true && text.startsWith("<![CDATA[", lt)) {
      end = to(lt + 9, "]]>");
    } else if (o.inline === true && !LETTER.test(text[lt + 2] ?? "")) {
      return literal;
    } else {
      end = to(lt + 2, ">");
    }
    return end === -1 ? unclosed : skip(end);
  }
  const closing = next === "/";
  const nameAt = closing ? lt + 2 : lt + 1;
  const first = text[nameAt];
  if (first === undefined || !LETTER.test(first)) {
    if (o.inline === true || !closing || first === undefined) return literal;
    return skip(first === ">" ? lt + 3 : to(lt + 2, ">"));
  }
  if (o.autolinks === true && !closing) {
    AUTOLINK.lastIndex = lt;
    const auto = AUTOLINK.exec(text);
    if (auto !== null) {
      const end = lt + auto[0].length;
      return { token: { kind: "autolink", url: auto[1]!, start: lt, end }, end, next: end };
    }
    EMAIL.lastIndex = lt;
    const email = EMAIL.exec(text);
    if (email !== null) return skip(lt + email[0].length);
  }
  // Tag name.
  let p = nameAt;
  while (p < n && !SPACE.test(text[p]!) && text[p] !== "/" && text[p] !== ">") p++;
  const name = text.slice(nameAt, p).toLowerCase();
  // Attributes.
  const attributes: Attribute[] = [];
  let complete = false;
  while (p < n) {
    while (p < n && (SPACE.test(text[p]!) || text[p] === "/")) p++;
    if (p >= n) break;
    if (text[p] === ">") {
      p++;
      complete = true;
      break;
    }
    const nameStart = p;
    if (text[p] === "=") p++;
    while (p < n && !SPACE.test(text[p]!) && !"/>=".includes(text[p]!)) p++;
    const attribute = text.slice(nameStart, p).toLowerCase();
    while (p < n && SPACE.test(text[p]!)) p++;
    let value = "";
    if (text[p] === "=") {
      p++;
      while (p < n && SPACE.test(text[p]!)) p++;
      const quote = text[p];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, p + 1);
        if (close === -1) {
          p = n;
          break;
        }
        value = text.slice(p + 1, close);
        p = close + 1;
      } else {
        const valueStart = p;
        while (p < n && !SPACE.test(text[p]!) && text[p] !== ">") p++;
        value = text.slice(valueStart, p);
      }
    }
    attributes.push({ name: attribute, value });
  }
  // A tag that the text ends inside of is dropped by a parser, and is only text in Markdown.
  if (!complete) return o.inline === true ? unclosed : skip(n);
  const tag: Tag = { kind: "tag", name, closing, attributes, start: lt, end: p };
  if (closing) return { token: tag, end: p, next: p };
  if (name === "plaintext") return { token: tag, end: p, next: n };
  if (RAW_TEXT.has(name)) {
    const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
    close.lastIndex = p;
    const found = close.exec(text);
    tag.body = { start: p, end: found === null ? n : found.index };
    return { token: tag, end: p, next: tag.body.end };
  }
  return { token: tag, end: p, next: p };
}

/**
 * The tags of an HTML or Markdown text, in order, as an HTML tokenizer finds them: comments,
 * doctypes and processing instructions are skipped, the content of raw text elements is skipped (its
 * offsets are on the start tag), attribute values may be quoted or not, and a tag that the text ends
 * inside of is dropped. See ReadOptions for the Markdown readings.
 */
export function tokens(text: string, o: ReadOptions = {}): Array<Tag | Autolink> {
  const out: Array<Tag | Autolink> = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    const read = readAt(text, lt, o);
    if (read.token !== undefined) out.push(read.token);
    i = read.next;
  }
  return out;
}

// ---- The policy for raw HTML written in Markdown ----

/**
 * The elements Markdown may use as raw HTML: text, structure, tables and pictures, which is what
 * GitHub shows too (it also drops the rest) plus a few harmless presentational ones. Anything else is
 * refused: that includes every element that runs code, embeds or loads another page, collects input,
 * changes the whole page (`style`, `link`, `meta`, `base`), or can carry script (`svg`, `math`), and
 * every custom element.
 */
export const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set(
  (
    "a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup " +
    "dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 h7 h8 header hr " +
    "i img ins kbd li main mark nav ol p picture pre q rp rt ruby s samp section small source span " +
    "strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr"
  ).split(" "),
);

/**
 * The names of the elements that HTML defines or once defined (and the roots of SVG and MathML). A name
 * outside both this list and ALLOWED_ELEMENTS is not an element a browser does anything with, such as
 * the `<name>` of `docker run <name>` that someone wrote without backticks: Jx writes it as an empty
 * element, which shows nothing and does no harm, so it is a warning and not an error.
 */
const KNOWN_ELEMENTS: ReadonlySet<string> = new Set(
  (
    "a abbr acronym address applet area article aside audio b base basefont bdi bdo bgsound big " +
    "blink blockquote body br button canvas caption center cite code col colgroup content data " +
    "datalist dd del details dfn dialog dir div dl dt em embed fencedframe fieldset figcaption " +
    "figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe " +
    "image img input ins isindex kbd keygen label legend li link listing main map mark marquee " +
    "math menu menuitem meta meter model multicol nav nextid nobr noembed noframes noscript " +
    "object ol optgroup option output p param picture plaintext portal pre progress q rb rp rt " +
    "rtc ruby s samp script search section select selectedcontent shadow slot small source " +
    "spacer span strike strong style sub summary sup svg table tbody td template textarea tfoot " +
    "th thead time title tr track tt u ul var video wbr webview xmp"
  ).split(" "),
);

/** The custom elements of the site itself: a page that writes one is borrowing a component. */
const SITE_COMPONENT = /^(?:docs-[a-z-]+|project-switcher|theme-toggle)$/;

/** Why an element that is not allowed is not allowed; the keys are the names a message can say more about. */
const WHY_ELEMENT: Record<string, string> = {
  script: "it runs code on the project's domain",
  iframe: "it embeds another page",
  frame: "it embeds another page",
  frameset: "it embeds other pages",
  object: "it embeds another page or plug-in",
  embed: "it embeds another page or plug-in",
  applet: "it embeds a plug-in",
  portal: "it embeds another page",
  form: "it can send what a reader types to another site",
  input: "it collects input",
  button: "it collects input",
  select: "it collects input",
  textarea: "it collects input",
  style: "it restyles the whole page",
  link: "it changes what the whole page loads",
  meta: "it can redirect or reconfigure the whole page",
  base: "it changes where every link and image of the page points",
  svg: "an inline SVG can carry scripts (put the drawing in an image file and use ![alt](file.svg))",
  math: "it can carry scripts",
  template: "it holds markup that scripts can activate",
  noscript: "it is parsed differently from other elements",
};

/** Attributes that are refused on every element, with the reason. `on*` event handlers are handled by name. */
const WHY_ATTRIBUTE: Record<string, string> = {
  style:
    "it can cover or restyle the whole page (GitHub removes it too: use Markdown, or the align attribute)",
  srcdoc: "it embeds a page",
  formaction: "it can send what a reader types to another site",
  ping: "it sends a request to another site when the link is followed",
  is: "it turns an element into one of the site's own components",
};

/** The attributes whose value is an address. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "poster",
  "cite",
  "action",
  "formaction",
  "background",
  "data",
  "longdesc",
  "codebase",
  "usemap",
  "manifest",
  "lowsrc",
  "dynsrc",
  "xlink:href",
]);

/** The addresses of an attribute value: one, or for `srcset` the address of each candidate. */
function addressesOf(attribute: string, value: string): string[] {
  if (attribute !== "srcset") return [value];
  return decodeReferences(value)
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((address) => address !== "");
}

const isHandler = (name: string): boolean => /^on[a-z]+$/.test(name);

/** Why an element is refused, when the policy knows more than "it is not on the list"; null for any other name. */
export function hazardReason(name: string): string | null {
  return Object.hasOwn(WHY_ELEMENT, name) ? WHY_ELEMENT[name]! : null;
}

/** What the policy refuses about one attribute of an element that is allowed, as sentences. */
export function attributeProblems(element: string, attribute: Attribute): string[] {
  const { name, value } = attribute;
  if (isHandler(name)) {
    return [
      `The ${name} attribute on <${element}> is an event handler: it runs code on the project's domain. Remove it.`,
    ];
  }
  if (Object.hasOwn(WHY_ATTRIBUTE, name)) {
    return [
      `The ${name} attribute on <${element}> is not allowed: ${WHY_ATTRIBUTE[name]}. Remove it.`,
    ];
  }
  if (!URL_ATTRIBUTES.has(name)) return [];
  const problems: string[] = [];
  for (const address of addressesOf(name, value)) {
    const bad = unsafeUrl(address);
    if (bad !== null) {
      problems.push(unsafeAddressMessage(`the ${name} of <${element}>`, address, bad));
    }
  }
  return problems;
}

/** One thing the policy has to say about a tag: an error refuses the page under strict, a warning only reports. */
export interface TagProblem {
  level: "error" | "warning";
  rule: "unsafe-html" | "html-unknown";
  message: string;
}

/**
 * What the policy says about one raw HTML tag in Markdown (nothing for a tag that is fine). End tags
 * are never a problem on their own: the start tag is.
 */
export function tagProblems(tag: Tag): TagProblem[] {
  if (tag.closing) return [];
  const error = (message: string): TagProblem => ({ level: "error", rule: "unsafe-html", message });
  if (!ALLOWED_ELEMENTS.has(tag.name)) {
    const why = hazardReason(tag.name);
    if (why !== null) {
      return [
        error(
          `<${tag.name}> is not allowed in documentation: ${why}. Raw HTML may only use text, table and image elements (the ones GitHub shows too).`,
        ),
      ];
    }
    if (KNOWN_ELEMENTS.has(tag.name) || SITE_COMPONENT.test(tag.name)) {
      return [
        error(
          `<${tag.name}> is not an element documentation may use. Raw HTML may only use text, table and image elements (the ones GitHub shows too); use Markdown instead.`,
        ),
      ];
    }
    return [
      {
        level: "warning",
        rule: "html-unknown",
        message: `<${tag.name}> is not an HTML element, so the site writes it as an empty element and shows nothing for it. If it is a placeholder, write it in backticks.`,
      },
    ];
  }
  return tag.attributes.flatMap((attribute) => attributeProblems(tag.name, attribute).map(error));
}

/** The message for an address that is refused; `where` says what holds it ("the link", "the href of <a>"). */
export function unsafeAddressMessage(where: string, address: string, bad: string): string {
  return `${where[0]!.toUpperCase()}${where.slice(1)} is "${excerpt(address)}" (${bad}): only http, https, mailto, tel and relative addresses may be linked, because a javascript: or data: address runs code or opens a page on the project's own domain.`;
}

// ---- The policy for what Jx wrote ----

/** Elements that no page of the site holds, whoever wrote them. */
const HAZARD_ANYWHERE = new Set([
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "base",
  "form",
  "xmp",
  "plaintext",
  "noembed",
  "noframes",
]);

/** Elements that the site's own pages hold only outside the page content (the head), never in the Markdown's HTML. */
const HAZARD_IN_CONTENT = new Set([
  "script",
  "style",
  "link",
  "meta",
  "template",
  "noscript",
  "math",
  "foreignobject",
]);

/** Attributes of the animation elements of SVG that can carry an address (`<set attributeName="href" to="javascript:...">`). */
const ANIMATED = new Set(["to", "from", "by", "values"]);

/** What `<meta http-equiv>` may not do on a page: send the reader elsewhere, set a cookie or switch the stylesheet. */
const PAGE_CONTROLS = new Set(["refresh", "set-cookie", "default-style"]);

/** The element that holds the Markdown's HTML (the `docs-prose` component of the site). */
export const CONTENT_ELEMENT = "docs-prose";

const SCRIPT_ADDRESS = /^(?:javascript|vbscript):/i;
/** A value as the URL parser would start reading it: references decoded, leading controls and spaces and all tabs and line breaks gone. */
const plain = (value: string): string =>
  decodeReferences(value)
    .replace(URL_START, "")
    .replaceAll(/[\t\n\r]/g, "");

/** A page's problems, bounded: `<tag attribute="value">` for each, once. */
export function pageHazards(html: string): string[] {
  const found = new Set<string>();
  let depth = 0;
  for (const token of tokens(html)) {
    if (token.kind !== "tag") continue;
    if (token.name === CONTENT_ELEMENT) depth = token.closing ? Math.max(0, depth - 1) : depth + 1;
    if (token.closing) continue;
    const inContent = depth > 0;
    const show = (attribute?: Attribute): string =>
      attribute === undefined
        ? `<${token.name}>`
        : `<${token.name} ${attribute.name}="${excerpt(decodeReferences(attribute.value), 50)}">`;
    if (HAZARD_ANYWHERE.has(token.name) || (inContent && HAZARD_IN_CONTENT.has(token.name))) {
      found.add(
        `${show()}${inContent && !HAZARD_ANYWHERE.has(token.name) ? " in the page content" : ""}`,
      );
    }
    for (const attribute of token.attributes) {
      const { name, value } = attribute;
      if (isHandler(name) || name === "srcdoc" || name === "formaction") found.add(show(attribute));
      else if (inContent && name === "style") found.add(show(attribute));
      else if (
        (URL_ATTRIBUTES.has(name) &&
          addressesOf(name, value).some((address) => unsafeUrl(address) !== null)) ||
        (ANIMATED.has(name) && SCRIPT_ADDRESS.test(plain(value)))
      ) {
        found.add(show(attribute));
      }
    }
    if (token.name === "meta") {
      const equiv = token.attributes
        .find((a) => a.name === "http-equiv")
        ?.value.trim()
        .toLowerCase();
      if (equiv !== undefined && PAGE_CONTROLS.has(equiv)) {
        found.add(`<meta http-equiv="${excerpt(equiv, 30)}">`);
      }
    }
  }
  return [...found];
}

// ---- Files published from the Markdown folder ----

/**
 * File types that a browser opens as a page or runs: a file of one of them that a page links to is
 * published beside the pages and runs on the project's domain when it is opened. Linked images, PDFs,
 * archives and data files are fine; an SVG is checked by `svgHazards`, an XML file by `xmlHazards`.
 */
export const ACTIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...["html", "htm", "xhtml", "xht", "shtml", "xsl", "xslt", "js", "mjs", "cjs", "hta"],
  ...["mht", "mhtml", "swf", "svgz", "mml", "mathml"],
]);

/** The extension of a path, lower case, or "". */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Elements an SVG file may not hold: they run code, load a page or switch to another markup language. */
const SVG_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "embed",
  "object",
  "applet",
  "handler",
  "listener",
  "html",
  "body",
  "head",
  "meta",
  "link",
  "base",
  "form",
]);

/** What makes an SVG file active: script, handlers, `javascript:` addresses, other documents, entities. */
export function svgHazards(svg: string): string[] {
  const found = new Set<string>();
  let root: string | null = null;
  for (const token of tokens(svg)) {
    if (token.kind !== "tag" || token.closing) continue;
    root ??= token.name;
    if (SVG_ELEMENTS.has(token.name)) found.add(`<${token.name}>`);
    for (const attribute of token.attributes) {
      const { name, value } = attribute;
      if (isHandler(name)) found.add(`${name}="${excerpt(value, 40)}"`);
      else if (
        ((name === "href" || name === "xlink:href" || name === "src") &&
          unsafeUrl(value, { dataImages: true }) !== null) ||
        (ANIMATED.has(name) && SCRIPT_ADDRESS.test(plain(value)))
      ) {
        found.add(`${name}="${excerpt(value, 40)}"`);
      }
    }
  }
  if (root !== null && root !== "svg") found.add(`a root element <${root}> instead of <svg>`);
  if (/<!ENTITY/i.test(svg)) found.add("an entity declaration");
  if (/<\?xml-stylesheet/i.test(svg)) found.add("an xml-stylesheet instruction");
  return [...found];
}

/** What makes an XML file active (it is shown as a page when it says it is XHTML or SVG, or names a stylesheet). */
export function xmlHazards(xml: string): string[] {
  const found: string[] = [];
  if (/<\?xml-stylesheet/i.test(xml)) found.push("an xml-stylesheet instruction");
  if (/xmlns(?::\w+)?\s*=\s*["']http:\/\/www\.w3\.org\/(?:1999\/xhtml|2000\/svg)["']/i.test(xml))
    found.push("an XHTML or SVG namespace");
  return found;
}
