// `non-null-assertion` subcommand: flags every TS non-null assertion —
// the postfix `!` operator (`x!`, `obj['k']!`, chains `a!.b!.c!`).
// Port of crap4dart's non_null_assertion gate (upstream commit
// e3ad58594c) with the JS host map:
//
// - Dart's postfix `!` maps to the TypeScript `TSNonNullExpression`
//   node, which only .ts/.tsx files can carry: @babel/parser routes the
//   typescript plugin by extension (complexity.js parseSource) and the
//   flow plugin has no such node — a .js file can never flag here (its
//   `!` is the logical-not prefix, a UnaryExpression).
// - Dart's null-assert pattern (`case var x!`) has no TS analog —
//   omitted (and so is upstream's pattern-side fix, the null-check
//   pattern `case var x?`).
// - Zero thresholds: any `!` is a finding, and the violation carries
//   the line of the `!` token — the bang is the node's last character,
//   so the node's end line is the token's line.
// - Not flagged, by construction: `!x` (UnaryExpression), `!=`/`!==`
//   (BinaryExpression), `++`/`--` (UpdateExpression), `?.`
//   (OptionalMemberExpression/OptionalCallExpression), `??`
//   (LogicalExpression) — none of these is a TSNonNullExpression.
// - Type casts are not bangs: `x as T` parses as TSAsExpression, and
//   the angle-bracket cast `<T>x` does not parse at all under the
//   port's jsx+typescript routing (ambiguous with JSX), so neither
//   reaches this gate.
//
// A bang crashes on null where the null-safe alternatives carry the
// same intent with a readable check: `?.`/`??` — the common
// check-then-bang ternary `E != null ? E!.m() : f` collapses to
// `E?.m() ?? f` (single receiver evaluation, no bang).
//
// Port conventions (crap4js has no gate framework or config file):
// default-on subcommand, warning severity — findings are printed but
// exit 0 by default; `--severity error` exits 2. Warning is the family
// posture for this gate: on an existing codebase every removed `!`
// needs a per-site nullability audit, and upstream adopts via the
// `check --save-baseline` baseline ratchet; crap4js has no baseline
// machinery, so the ratchet stays prose (README): freeze the count,
// drive it to zero, then flip to `--severity error`. Violations honor
// ignore markers (`non-null-assertion` is in IGNORABLE_GATES).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { childrenOf, parseSource } from './complexity.js';

const GATE_ID = 'non-null-assertion';
const WARNING = 'warning';
const ERROR = 'error';
const SEVERITIES = new Set([WARNING, ERROR]);
const SEVERITY_FLAG = { '--severity': 'severity' };

// The only node this gate flags; the parser emits it on the typescript
// plugin route alone.
const NON_NULL_ASSERTION = 'TSNonNullExpression';

/**
 * Non-null-assertion violations across files. `checked` counts the
 * scanned files.
 *
 * @param {string[]} files  absolute source-file paths.
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function nonNullAssertionViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, UTF8);
    scanProgram(parseSource(source, path.extname(file)).program, {
      file: toRelPath(file, projectRoot),
      violations,
    });
    checked++;
  }
  return { violations, checked };
}

// One generic AST walk: every TSNonNullExpression is a bang. The
// exclusions need no checks — the parser gives them distinct node
// types, none of which is TSNonNullExpression.
function scanProgram(program, state) {
  const visit = (node) => {
    if (node.type === NON_NULL_ASSERTION) {
      state.violations.push({
        file: state.file,
        line: node.loc.end.line,
        message:
          'non-null assertion (`!`) — a null value crashes here; use `?.`/`??` or a null check on a local variable',
      });
    }
    for (const kid of childrenOf(node)) visit(kid);
  };
  visit(program);
}

/**
 * One-line summary: `M files scanned, no non-null assertions`, or
 * `N non-null assertion(s) (M files scanned)`.
 */
export function nonNullAssertionSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} files scanned, no non-null assertions`
    : `${violations} non-null assertion(s) (${checked} files scanned)`;
}

/**
 * The `non-null-assertion` command body: `--severity error` makes
 * violations fail (exit 2); the default warning severity reports and
 * exits 0. Unknown flags and unknown severity values are usage errors
 * (exit 1).
 */
export function runNonNullAssertion(argv, ctx) {
  const opts = { severity: WARNING, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, SEVERITY_FLAG);
  }
  if (!SEVERITIES.has(opts.severity)) {
    throw new Error(`--severity must be ${WARNING} or ${ERROR}: ${opts.severity}`);
  }
  const code = runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    nonNullAssertionViolations,
    nonNullAssertionSummary,
    GATE_ID,
  );
  return opts.severity === ERROR ? code : 0;
}
