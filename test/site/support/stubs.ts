// Some checks of the site assets need the real code of a neighbouring work package (WP3's route rules,
// WP4's contrast gate). Until that package is merged its module is still the WP0 stub, whose functions
// throw "not implemented (WPn)": those checks are skipped, with the reason in the test's name, and
// start running by themselves on the first run after the merge. A real failure of a real
// implementation is never swallowed: only the stub's own message counts as "not there yet".

/** Whether the function behind `probe` is real code rather than a WP0 stub. */
export function implemented(probe: () => unknown): boolean {
  try {
    probe();
    return true;
  } catch (error) {
    return !(error instanceof Error && /^not implemented \(WP\d+\)/.test(error.message));
  }
}
