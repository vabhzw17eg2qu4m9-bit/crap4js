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
 * Shared repeatable-flag argv walker for the gate subcommands: value flags
 * come as `--flag VALUE` or `--flag=VALUE` (`valueFlags` maps flag → opts
 * key); number flags (`numberFlags`) are validated and stored as scalars,
 * every other flag accumulates values into an array; any non-flag token is
 * collected into `opts.paths`. Returns the index of the last consumed argv
 * token.
 */
export function applyGateArg(opts, arg, argv, i, valueFlags, numberFlags = null) {
  const eq = arg.indexOf('=');
  const head = eq === -1 ? arg : arg.slice(0, eq);
  const key = valueFlags[head];
  if (!key) {
    if (eq !== -1) throw new Error(`unknown flag: ${head}`);
    opts.paths.push(arg);
    return i;
  }
  const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
  return applyGateValue(opts, key, head, value, eq === -1 ? i + 1 : i, numberFlags);
}

// Stores one flag value: number flags are validated scalars, every other
// flag accumulates into an array (all gate flags are repeatable).
function applyGateValue(opts, key, head, value, ret, numberFlags) {
  if (value === undefined) throw new Error(`${head} requires a value`);
  opts[key] = numberFlags?.has(head)
    ? toGateNumber(head, value)
    : [...(opts[key] ?? []), value];
  return ret;
}

function toGateNumber(head, value) {
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) throw new Error(`Invalid ${head}: ${value}`);
  return n;
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
