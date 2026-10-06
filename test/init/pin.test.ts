import { describe, expect, test } from "vitest";
import {
  bareVersion,
  repinWorkflow,
  resolvePin,
  resolveWorkflowPin,
  tagOf,
} from "../../src/lib/pin.js";
import { SHA, SHA2 } from "./support/shell.js";

const TAG_OBJECT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("resolveWorkflowPin", () => {
  test("asks git ls-remote for the peeled tag and the tag", () => {
    const calls: string[][] = [];
    resolveWorkflowPin("0.1.0", {
      lsRemote: (args) => {
        calls.push(args);
        return "";
      },
    });
    expect(calls).toEqual([
      [
        "ls-remote",
        "https://github.com/Avunu/docusystem",
        "refs/tags/v0.1.0^{}",
        "refs/tags/v0.1.0",
      ],
    ]);
  });

  test("prefers the peeled line: an annotated tag's own id is not a commit", () => {
    const output = `${TAG_OBJECT}\trefs/tags/v0.1.0\n${SHA}\trefs/tags/v0.1.0^{}\n`;
    expect(resolveWorkflowPin("0.1.0", { lsRemote: () => output })).toBe(SHA);
    // the order of the lines does not matter
    const reversed = `${SHA}\trefs/tags/v0.1.0^{}\n${TAG_OBJECT}\trefs/tags/v0.1.0\n`;
    expect(resolveWorkflowPin("v0.1.0", { lsRemote: () => reversed })).toBe(SHA);
  });

  test("a lightweight tag has only the tag line, which is the commit", () => {
    expect(resolveWorkflowPin("0.1.0", { lsRemote: () => `${SHA2}\trefs/tags/v0.1.0\n` })).toBe(
      SHA2,
    );
  });

  test("ignores other tags, malformed lines and non-commit ids", () => {
    const output = [
      `${SHA}\trefs/tags/v0.1.1`,
      `${SHA}\trefs/tags/v0.1.0-rc.1`,
      "not-a-sha\trefs/tags/v0.1.0",
      `${SHA.toUpperCase()}\trefs/tags/v0.1.0`,
      "",
    ].join("\n");
    expect(resolvePin("0.1.0", { lsRemote: () => output })).toEqual({
      sha: null,
      reason: "Avunu/docusystem has no tag v0.1.0",
    });
  });

  test("a failing or missing git is a reason, not an exception", () => {
    const result = resolvePin("0.1.0", {
      lsRemote: () => {
        throw new Error("fatal: unable to access: Could not resolve host\n");
      },
    });
    expect(result.sha).toBeNull();
    expect(result.reason).toContain("could not ask Avunu/docusystem for the tag v0.1.0");
    expect(result.reason).toContain("Could not resolve host");
  });

  test("without an injected resolver git is run; a missing git is a reason, not a crash", () => {
    const result = resolvePin("0.1.0", { env: { PATH: "/nonexistent" } });
    expect(result.sha).toBeNull();
    expect(result.reason).toContain("git is not installed or not on PATH");
  });

  test("only a version is ever put into a git ref", () => {
    const calls: string[][] = [];
    for (const bad of ["", "latest", "1.2", "0.1.0 --upload-pack=x", "../../x", "v1.2.3.4"]) {
      const result = resolvePin(bad, {
        lsRemote: (args) => {
          calls.push(args);
          return "";
        },
      });
      expect(result.sha, bad).toBeNull();
      expect(result.reason, bad).toContain("is not a version");
    }
    expect(calls).toEqual([]);
  });
});

describe("version text", () => {
  test("bareVersion and tagOf", () => {
    expect(bareVersion("v0.1.0")).toBe("0.1.0");
    expect(bareVersion(" 1.2.3-rc.1 ")).toBe("1.2.3-rc.1");
    expect(bareVersion("1.2")).toBeNull();
    expect(tagOf("0.1.0")).toBe("v0.1.0");
    expect(() => tagOf("x")).toThrow(/not a version/);
  });
});

describe("repinWorkflow", () => {
  const caller = (sha: string, comment: string): string =>
    [
      "name: Docs",
      "jobs:",
      "  build:",
      "    permissions:",
      "      contents: read # checkout",
      `    uses: Avunu/docusystem/.github/workflows/docs-build.yml@${sha}${comment}`,
      "    with:",
      "      site-directory: docs-site",
      "  deploy:",
      "    needs: build",
      `    uses: Avunu/docusystem/.github/workflows/docs-deploy.yml@${sha}${comment}`,
      "",
    ].join("\n");

  test("re-pins every uses line and changes nothing else", () => {
    const before = caller(SHA, " # v0.1.0");
    const after = repinWorkflow(before, SHA2, "0.2.0");
    expect(after).toBe(caller(SHA2, " # v0.2.0"));
  });

  test("replaces a tag, a branch or a stale comment by the commit and the version", () => {
    expect(repinWorkflow(caller("v1", ""), SHA, "0.1.0")).toBe(caller(SHA, " # v0.1.0"));
    expect(repinWorkflow(caller("main", " # whatever"), SHA, "v0.1.0")).toBe(
      caller(SHA, " # v0.1.0"),
    );
  });

  test("is the same text when everything is pinned there already", () => {
    const text = caller(SHA, " # v0.1.0");
    expect(repinWorkflow(text, SHA, "0.1.0")).toBe(text);
  });

  test("null when the file calls no workflow of this repository", () => {
    expect(
      repinWorkflow("name: x\njobs:\n  a:\n    uses: actions/checkout@v4\n", SHA, "0.1.0"),
    ).toBeNull();
    // another repository with a similar name is not ours
    expect(
      repinWorkflow(
        "    uses: Avunu/docusystem-fork/.github/workflows/docs-build.yml@v1\n",
        SHA,
        "0.1.0",
      ),
    ).toBeNull();
  });

  test("keeps CRLF line endings and a missing final newline", () => {
    const crlf = caller(SHA, " # v0.1.0").replace(/\n/g, "\r\n");
    expect(repinWorkflow(crlf, SHA2, "0.2.0")).toBe(
      caller(SHA2, " # v0.2.0").replace(/\n/g, "\r\n"),
    );
    const bare = caller(SHA, "").trimEnd();
    expect(repinWorkflow(bare, SHA2, "0.2.0")).toBe(caller(SHA2, " # v0.2.0").trimEnd());
  });

  test("refuses a pin that is not a full commit id", () => {
    expect(() => repinWorkflow(caller(SHA, ""), "v0.1.0", "0.1.0")).toThrow(/full commit id/);
    expect(() => repinWorkflow(caller(SHA, ""), SHA.slice(0, 7), "0.1.0")).toThrow(
      /full commit id/,
    );
  });
});
