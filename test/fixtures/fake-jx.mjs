// A stand-in for the Jx command line, for the tests of `docusystem jx`: prints what it was given as one
// JSON line on standard output and a line on standard error, then exits with $FAKE_JX_EXIT.
import { existsSync } from "node:fs";

const lock = process.env.FAKE_LOCK_FILE;
console.log(
  JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    locked: lock === undefined ? null : existsSync(lock),
  }),
);
console.error("fake jx: a line on standard error");
process.exit(Number(process.env.FAKE_JX_EXIT ?? 0));
