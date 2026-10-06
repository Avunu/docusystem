// What differs between the platforms the tests run on (Linux and macOS in CI's required jobs, Windows in
// the informational one), so that a test says what it means once instead of each file guessing.
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

export const isWindows: boolean = process.platform === "win32";

/**
 * A path or a text with the platform's separator written as `/`, for comparing with an expectation
 * that is written once for every platform. The identity on POSIX.
 */
export const slash = (text: string): string => (sep === "/" ? text : text.replaceAll(sep, "/"));

/** A `/`-separated relative path with the platform's separator, as `fs.watch` reports it. */
export const native = (path: string): string => (sep === "/" ? path : path.replaceAll("/", sep));

/** `text` as a regular expression that matches exactly `text` (a Windows path is full of backslashes). */
export const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/**
 * The permission bits of a file that `copyFile` and `replaceDir` write: `0644` on POSIX. Windows has
 * no permission bits: Node reports `0666` for a writable file and `0444` for a read-only one, and what
 * the product promises there (a copy stays writable, so that the next run can replace it) is the
 * first of the two.
 */
export const WRITABLE_FILE_MODE: number = isWindows ? 0o666 : 0o644;

let symlinks: boolean | undefined;

/**
 * Whether this process can create a symbolic link. Always on Linux and macOS. On Windows only an
 * administrator, or an account with Developer Mode on, can; the windows-latest runner is the first.
 * Probed once, on first use, because most test files never ask.
 */
export function canSymlink(): boolean {
  if (symlinks !== undefined) return symlinks;
  const dir = mkdtempSync(join(tmpdir(), "docusystem-probe-"));
  try {
    symlinkSync("target", join(dir, "link"));
    symlinks = true;
  } catch {
    symlinks = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return symlinks;
}
