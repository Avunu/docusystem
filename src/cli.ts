#!/usr/bin/env node
// The `docusystem` binary: runs the command line and exits with the code main.ts returns. The code is
// set on the process rather than passed to process.exit, so that what the command printed to a pipe
// is flushed first.
import { run } from "./main.js";

// A reader that went away (`docusystem --help | head -1`) is not an error of ours: drop what it no
// longer wants and keep the exit code the command earned. Any other stream error is still fatal.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
}

process.exitCode = await run(process.argv.slice(2));
