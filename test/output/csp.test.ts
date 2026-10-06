import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  inlineScripts,
  policyFor,
  policyProblems,
  scriptHash,
  withContentSecurityPolicy,
} from "../../src/lib/csp.js";

const THEME = '(function(){try{var s=localStorage.getItem("jx-color-scheme")}catch(e){}})()';
const MAP = '{"imports":{"lit-html":"/assets/lit-html.js"}}';
const page = (head = "", body = "<p>x</p>") =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf8"><meta name="viewport" content="width=device-width">${head}<title>T</title></head><body>${body}</body></html>`;
const SITE_HEAD = `<script>${THEME}</script><script type="importmap">${MAP}</script><script type="module" src="/components/a.js"></script><style>a{}</style>`;

const policyOf = (html: string): string =>
  /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";

describe("inlineScripts", () => {
  test("the inline scripts a browser runs: classic, module, import map and the JavaScript types", () => {
    const html = page(
      `<script>a()</script><script type="module">b()</script><script type="importmap">${MAP}</script><script type="text/javascript">c()</script><script type=" Application/JavaScript ">d()</script><script type="">e()</script>`,
    );
    expect(inlineScripts(html)).toEqual(["a()", "b()", MAP, "c()", "d()", "e()"]);
  });

  test("not scripts with a src, and not data blocks", () => {
    const html = page(
      '<script src="/a.js">ignored()</script><script type="application/json">{"a":1}</script><script type="application/ld+json">{}</script><script type="text/template"><b></b></script>',
    );
    expect(inlineScripts(html)).toEqual([]);
  });

  test("a < or a quote in a script does not end it", () => {
    expect(inlineScripts(page("<script>if (a<b) { x = '</div>' }</script>"))).toEqual([
      "if (a<b) { x = '</div>' }",
    ]);
  });
});

describe("scriptHash", () => {
  test("is the base64 SHA-256 of the text, in the form a policy uses", () => {
    expect(scriptHash("")).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
    expect(scriptHash("alert(1)")).toBe(
      `'sha256-${createHash("sha256").update("alert(1)").digest("base64")}'`,
    );
    // UTF-8, as a browser hashes the text
    expect(scriptHash("é")).toBe(
      `'sha256-${createHash("sha256").update(Buffer.from("é")).digest("base64")}'`,
    );
  });
});

describe("policyFor", () => {
  test("blocks inline scripts that are not named, embedding, base changes and forms", () => {
    const policy = policyFor([THEME, MAP]).split("; ");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain(`script-src 'self' ${scriptHash(THEME)} ${scriptHash(MAP)}`);
    for (const directive of [
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-src 'none'",
    ]) {
      expect(policy).toContain(directive);
    }
    expect(policyFor([THEME, MAP])).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  });

  test("allows what the site loads and nothing else: itself, the catalog, https images", () => {
    const policy = policyFor([]).split("; ");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'self' https://avunu.net");
    expect(policy).toContain("img-src 'self' https:");
    expect(policy).toContain("font-src 'self'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
  });

  test("names an inline script once, however often it stands", () => {
    expect(policyFor([THEME, THEME])).toBe(policyFor([THEME]));
  });
});

describe("withContentSecurityPolicy", () => {
  test("puts the policy right after the charset meta, before every script and link", () => {
    const out = withContentSecurityPolicy(page(SITE_HEAD));
    const at = out.indexOf('<meta http-equiv="Content-Security-Policy"');
    expect(at).toBe('<!DOCTYPE html><html lang="en"><head><meta charset="utf8">'.length);
    expect(at).toBeLessThan(out.indexOf('<meta name="viewport"'));
    expect(at).toBeLessThan(out.indexOf("<script"));
    expect(out.slice(0, 1024)).toContain("charset");
  });

  test("names every inline script by its hash, and no other", () => {
    const policy = policyOf(withContentSecurityPolicy(page(SITE_HEAD)));
    expect(policy).toContain(scriptHash(THEME));
    expect(policy).toContain(scriptHash(MAP));
    expect(policy.match(/'sha256-/g)).toHaveLength(2);
  });

  test("a page whose head has no charset meta gets it right after <head>", () => {
    expect(withContentSecurityPolicy("<html><head><title>x</title></head></html>")).toMatch(
      /^<html><head><meta http-equiv="Content-Security-Policy" content="[^"]*" data-docusystem-csp><title>/,
    );
    expect(
      withContentSecurityPolicy('<HTML><HEAD lang="en"><TITLE>x</TITLE></HEAD></HTML>'),
    ).toMatch(/^<HTML><HEAD lang="en"><meta http-equiv=/);
  });

  test("is idempotent, and follows a change of the page's scripts", () => {
    const once = withContentSecurityPolicy(page(SITE_HEAD));
    expect(withContentSecurityPolicy(once)).toBe(once);
    const changed = withContentSecurityPolicy(once.replace(THEME, "other()"));
    expect(policyOf(changed)).toContain(scriptHash("other()"));
    expect(policyOf(changed)).not.toContain(scriptHash(THEME));
    expect(changed.match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  test("a policy that the page already has is kept: two policies are both enforced", () => {
    const own = '<meta http-equiv="Content-Security-Policy" content="img-src \'none\'">';
    const out = withContentSecurityPolicy(page(own));
    expect(out).toContain(own);
    expect(out.match(/Content-Security-Policy/g)).toHaveLength(2);
    expect(out.indexOf("data-docusystem-csp")).toBeLessThan(out.indexOf(own));
  });

  test("a document with no head is returned as it is", () => {
    expect(withContentSecurityPolicy("<p>not a page</p>")).toBe("<p>not a page</p>");
    expect(withContentSecurityPolicy("google-site-verification: google123.html")).toBe(
      "google-site-verification: google123.html",
    );
  });

  test("a <head> inside a comment or a script is not the head", () => {
    const html = "<!-- <head> --><html><head><title>x</title></head></html>";
    expect(withContentSecurityPolicy(html).indexOf("Content-Security-Policy")).toBeGreaterThan(
      html.indexOf("</head") - 1000,
    );
    expect(
      withContentSecurityPolicy(html).startsWith("<!-- <head> --><html><head><meta http-equiv"),
    ).toBe(true);
  });
});

describe("policyProblems", () => {
  const good = withContentSecurityPolicy(page(SITE_HEAD));

  test("a page that the build made has none", () => {
    expect(policyProblems(good)).toEqual([]);
  });

  test("a file with no head is not a page it can govern", () => {
    expect(policyProblems("google-site-verification: x.html")).toEqual([]);
    expect(policyProblems("<!DOCTYPE html><title>v</title><h1>v</h1>")).toEqual([]);
  });

  test("no policy", () => {
    expect(policyProblems(page(SITE_HEAD))).toEqual(["it has no Content-Security-Policy meta"]);
  });

  test("a policy after a script or a link governs nothing before it", () => {
    const late = page(`<script>${THEME}</script>`).replace(
      "</head>",
      `${/<meta http-equiv[^>]*>/.exec(good)![0]}</head>`,
    );
    expect(policyProblems(late)).toEqual([
      "its Content-Security-Policy comes after a <script>, which it cannot govern",
    ]);
    const lateLink = page('<link rel="stylesheet" href="/a.css">', "").replace(
      "</head>",
      `${/<meta http-equiv[^>]*>/.exec(withContentSecurityPolicy(page()))![0]}</head>`,
    );
    expect(policyProblems(lateLink)[0]).toMatch(/comes after a <link>/);
  });

  test("a policy that lets scripts run from anywhere, or lets pages and forms in", () => {
    const weaken = (from: string, to: string): string => good.replace(from, to);
    expect(
      policyProblems(weaken("script-src 'self'", "script-src 'self' 'unsafe-inline'")),
    ).toEqual(["script-src allows 'unsafe-inline'"]);
    expect(policyProblems(weaken("script-src 'self'", "script-src *"))).toEqual([
      "script-src allows *",
    ]);
    expect(
      policyProblems(weaken("script-src 'self'", "script-src 'self' https://cdn.example.com")),
    ).toEqual(["script-src allows https://cdn.example.com"]);
    expect(policyProblems(weaken("script-src 'self'", "script-src 'self' data: blob:"))).toEqual([
      "script-src allows data: blob:",
    ]);
    expect(policyProblems(weaken("object-src 'none'", "object-src *"))).toEqual([
      "object-src allows *",
    ]);
    expect(policyProblems(weaken("form-action 'none'", "form-action https://example.com"))).toEqual(
      ["form-action allows https://example.com"],
    );
    expect(policyProblems(weaken("base-uri 'none'; ", ""))).toEqual([
      "its Content-Security-Policy has no base-uri",
    ]);
  });

  test("an inline script that the policy does not name", () => {
    const sneaky = good.replace("</body>", "<script>alert(1)</script></body>");
    expect(policyProblems(sneaky)).toEqual([
      "an inline script (alert(1)...) is not named by its hash",
    ]);
  });

  test("a policy with no script-src falls back to default-src, which must not be open", () => {
    const noScriptSrc = good.replace(/script-src [^;]*; /, "");
    expect(policyProblems(noScriptSrc)).toEqual([
      expect.stringMatching(/^an inline script .* is not named by its hash$/),
      expect.stringMatching(/^an inline script .* is not named by its hash$/),
    ]);
    expect(
      policyProblems(
        good.replace(/script-src [^;]*; /, "").replace("default-src 'self'", "default-src *"),
      )[0],
    ).toBe("script-src allows *");
    expect(
      policyProblems(good.replace(/default-src [^;]*; /, "").replace(/script-src [^;]*; /, "")),
    ).toContain("its Content-Security-Policy has no script-src");
  });

  test("the first policy of a page is the one that is judged, the others can only narrow it", () => {
    const narrowed = good.replace(
      "</head>",
      '<meta http-equiv="Content-Security-Policy" content="default-src *"></head>',
    );
    expect(policyProblems(narrowed)).toEqual([]);
  });
});
