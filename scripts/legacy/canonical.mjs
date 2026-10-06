// How the migration recognizes a JSON file of the starter whose only differences are values the shell now
// derives (the project name, the address). The bytes cannot be compared: a pilot's formatter may have
// re-wrapped a short array, and the name and URL differ by project. So the file is read as JSON, the
// named top-level keys are dropped, and what remains is written in one canonical form (keys sorted at
// every level, arrays in their order, no insignificant whitespace) and hashed.
//
// The hashes in starter-v0.json were made with this function by generate-starter-v0.mjs; migrate-pilot.mjs
// makes the same hash of a pilot's file and compares.
import { createHash } from "node:crypto";

/** `value` with the keys of every object sorted, so that equal data has one text. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

/** The sha256 (hex) of the canonical form of `value` without its top-level keys `ignore`. */
export function canonicalSha256(value, ignore = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected a JSON object");
  }
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => !ignore.includes(key)));
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(kept)))
    .digest("hex");
}
