// Shared plumbing for the gate-check subcommands (nesting, class-size,
// weight-of-class, unused-code, unused-files, banned-imports), all ported
// from crap4dart 0.5.x gates: print one line per violation plus a summary;
// exit code 2 iff violations exist.

// Whole-project checks (unused-code, unused-files) cannot run on an
// explicit path selection — a partial file set yields false positives
// (crap4dart 0.5.1 behavior).
export const PARTIAL_SELECTION_SKIP =
  'not meaningful for a partial selection — skipped';

/**
 * Print the skip message for a whole-project check invoked with explicit
 * paths and return exit code 0.
 */
export function skipPartialSelection(ctx) {
  ctx.out.write(`${PARTIAL_SELECTION_SKIP}\n`);
  return 0;
}

/**
 * The common command body of every gate-check subcommand: run
 * `findViolations(files, projectRoot)`, print `file[:line]: message` per
 * violation plus one summary line, and return the exit code.
 *
 * @param {object} ctx  { out, cwd } as built by the CLI.
 * @param {string[]} files  absolute file paths to check.
 * @param {Function} findViolations  (files, projectRoot) =>
 *   { violations: Array<{file, line?, message}>, checked: number }.
 * @param {Function} summary  ({ violations, checked }) => string.
 * @returns {number} exit code — 2 iff violations exist.
 */
export function runCheck(ctx, files, findViolations, summary) {
  if (files.length === 0) {
    ctx.out.write('No source files to check.\n');
    return 0;
  }
  const result = findViolations(files, ctx.cwd);
  for (const v of result.violations) {
    ctx.out.write(`${v.file}${v.line ? `:${v.line}` : ''}: ${v.message}\n`);
  }
  ctx.out.write(summary({ ...result, violations: result.violations.length }) + '\n');
  return result.violations.length > 0 ? 2 : 0;
}
