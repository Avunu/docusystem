// A catalog, and a server for it on the loopback interface (the tests never use the network).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import { tempDir } from "../support/index.js";

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
});

/** Starts a server on the loopback interface (closed after the test); returns its address. */
export async function serve(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects.json`;
}

/** Stops listening on the address of the most recent server, which stays in the list. */
export async function stopLast(): Promise<void> {
  const server = servers.at(-1);
  if (server === undefined) return;
  await new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
}

/** Answers 200 with `body` (a string as it is, anything else as JSON). */
export const json =
  (body: unknown): Handler =>
  (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };

/** Answers with a status code and a body. */
export const status =
  (code: number, body = ""): Handler =>
  (_request, response) => {
    response.statusCode = code;
    response.end(body);
  };

/** A file that holds `contents`, in a folder of its own. */
export function fileWith(contents: string): { dir: string; out: string } {
  const dir = tempDir();
  const out = join(dir, "snapshot.json");
  writeFileSync(out, contents);
  return { dir, out };
}
