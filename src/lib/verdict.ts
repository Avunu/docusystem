// The small vocabulary of the output assertions (assert.ts and safety.ts): a passed or failed
// assertion, and the bounded list and the plural that their messages use.
import type { Assertion } from "./types.js";

export const pass = (message: string): Assertion => ({ ok: true, message });
export const fail = (message: string): Assertion => ({ ok: false, message });
export const verdict = (ok: boolean, good: string, bad: string): Assertion =>
  ok ? pass(good) : fail(bad);

/** `a, b, c and 4 more`: a bounded list for a message. */
export function listOf(items: string[], max = 5): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
