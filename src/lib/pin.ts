// STUB owned by WP6: the signatures are frozen (Appendix B of the architecture decision record); the
// bodies are the work package's to write and replace the throws below. WP0 never edits this file again.
/** The commit of tag `v<version>` of Avunu/docusystem (`git ls-remote`, injectable), or null. */
export function resolveWorkflowPin(
  _version: string,
  _o?: { lsRemote?: (args: string[]) => string },
): string | null {
  throw new Error("not implemented (WP6)");
}

/** Re-pins every `uses: Avunu/docusystem/...` line of a caller workflow; null when there is none. */
export function repinWorkflow(_text: string, _sha: string, _version: string): string | null {
  throw new Error("not implemented (WP6)");
}
