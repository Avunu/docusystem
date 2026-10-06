// Types for tests and editors; the script itself is plain JavaScript.
export const BUDGET: { packed: number; unpacked: number; files: number };
export const ALLOWED: readonly RegExp[];
export const REQUIRED: readonly string[];
export const FORBIDDEN: readonly RegExp[];
export const INSTALL_HOOKS: readonly string[];
export function problemsWith(tarball: {
  paths: readonly string[];
  size: number;
  unpackedSize: number;
  scripts?: Record<string, string>;
}): string[];
