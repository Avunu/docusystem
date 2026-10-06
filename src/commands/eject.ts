// `docusystem eject` (sections 2.3, 4.1 and 6 of the architecture decision record): copies package
// files into `<site>/overrides/` so that a project can change them, and records each copy in
// `overrides/.ejected.json` with the version and the sha256 of the package file it came from, which is
// what lets `doctor` say later that the package's file has changed. The copying and the record are
// `ejectFile` of the assemble package (WP2); this command decides which files, and all or nothing.
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { findSiteDir } from "../lib/config.js";
import { walkFiles } from "../lib/fsutil.js";
import { ejectFile } from "../lib/overrides.js";
import { packageRoot } from "../lib/package-info.js";
import { EXIT, type CommandContext } from "./types.js";

/** The folders of the package's `site/` whose files can be ejected (public files are replaced by putting a file in `public/`). */
const EJECTABLE = ["components", "layouts", "pages"] as const;

/** What `run` needs from outside; tests replace it. */
export interface EjectDeps {
  /** The package's `site/` folder. Default: the installed package's. */
  siteRoot?: string;
}

/** Every file of the package that can be ejected, as `components/docs-footer.json`, sorted. */
export function ejectableFiles(siteRoot: string): string[] {
  const files: string[] = [];
  for (const folder of EJECTABLE) {
    const { files: inside } = walkFiles(join(siteRoot, folder), { repoRoot: siteRoot });
    for (const file of inside) files.push(`${folder}/${file}`);
  }
  return files.sort();
}

export async function run(ctx: CommandContext): Promise<number> {
  return runEject(ctx, {});
}

/** `run` with its outside world injectable. */
export async function runEject(ctx: CommandContext, deps: EjectDeps): Promise<number> {
  const { args, options } = ctx;
  const usage = (message: string): number => {
    ctx.stderr(`docusystem: eject: ${message}`);
    ctx.stderr(
      "Usage: docusystem eject (<components/file> | <layouts/file> | <pages/file>)... | --all  [--force]",
    );
    return EXIT.usage;
  };
  const fail = (message: string): number => {
    ctx.stderr(`docusystem: eject: ${message}`);
    return EXIT.problems;
  };
  if (options.all === true && args.length > 0) {
    return usage("give files, or --all, not both");
  }
  if (options.all !== true && args.length === 0) {
    return usage(
      "name the files to eject (for example components/docs-footer.json), or give --all",
    );
  }

  let siteDir: string;
  try {
    siteDir = findSiteDir(options.site, ctx.cwd);
  } catch (error) {
    return fail((error as Error).message);
  }

  const siteRoot = deps.siteRoot ?? join(packageRoot, "site");
  const available = ejectableFiles(siteRoot);
  let wanted: string[];
  if (options.all === true) {
    wanted = available;
  } else {
    const unknown: string[] = [];
    wanted = [];
    for (const arg of args) {
      const rel = arg.replace(/^(?:\.\/)+/, "");
      if (available.includes(rel)) {
        if (!wanted.includes(rel)) wanted.push(rel);
      } else unknown.push(arg);
    }
    if (unknown.length > 0) {
      return fail(
        `the package has no file ${unknown.map((u) => `"${u}"`).join(", ")} to eject. ` +
          (available.length === 0
            ? "It ships no components, layouts or pages."
            : `It ships: ${available.join(", ")}`),
      );
    }
  }
  if (wanted.length === 0)
    return fail("the package ships no components, layouts or pages to eject");

  // All or nothing: an override that is there already is never replaced without --force.
  const force = options.force === true;
  const overridden = wanted.filter((rel) =>
    existsSync(join(siteDir, "overrides", ...rel.split("/"))),
  );
  if (overridden.length > 0 && !force) {
    return fail(
      `${overridden.length === 1 ? "an override exists" : "overrides exist"} already: ` +
        `${overridden.map((rel) => `overrides/${rel}`).join(", ")}. ` +
        `Nothing was copied. Use --force to replace ${overridden.length === 1 ? "it with the package's file (your changes to it are lost)" : "them with the package's files (your changes to them are lost)"}`,
    );
  }

  const copied: string[] = [];
  try {
    for (const rel of wanted) {
      const { to } = ejectFile(siteDir, rel, { force });
      copied.push(
        relative(siteDir, isAbsolute(to) ? to : join(siteDir, to))
          .split(sep)
          .join("/"),
      );
    }
  } catch (error) {
    return fail(
      `${(error as Error).message}${copied.length > 0 ? ` (already copied: ${copied.join(", ")})` : ""}`,
    );
  }
  for (const file of copied) ctx.stdout(`eject: ${file}`);
  ctx.stdout(
    `eject: ${copied.length} file${copied.length === 1 ? "" : "s"} copied into overrides/ and recorded in overrides/.ejected.json.`,
  );
  ctx.stdout(
    "These files no longer follow package updates: `docusystem doctor` tells you when the package's version of one has changed.",
  );
  return EXIT.ok;
}
