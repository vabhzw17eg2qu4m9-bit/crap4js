// `method-size` subcommand: fails methods longer than --max-lines body
// lines (default 60) or with more than --max-params parameters (default 6).
// Port of crap4dart's method_size gate (0.5.x) with the config flattened to
// CLI flags. Constructors are checked for the parameter count only
// (upstream rule); top-level functions and every other function-like entry
// are checked like methods. Body lines are `endLine - startLine + 1` and
// the violation carries the method's start line.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { CONSTRUCTOR, extractMethodsWithNodes } from './complexity.js';

const MAX_LINES = 60;
const MAX_PARAMS = 6;

const GATE_FLAGS = { '--max-lines': 'maxLines', '--max-params': 'maxParams' };
const NUMBER_FLAGS = new Set(['--max-lines', '--max-params']);

/**
 * Method-size violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {{ maxLines?: number, maxParams?: number }} [opts]
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function methodSizeViolations(files, projectRoot, { maxLines = MAX_LINES, maxParams = MAX_PARAMS } = {}) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const rel = toRelPath(file, projectRoot);
    const source = readFileSync(file, UTF8);
    const methods = extractMethodsWithNodes(source, { ext: path.extname(file), includeConstructors: true });
    for (const m of methods) {
      checked++;
      pushSize(violations, rel, m, m.node.kind === CONSTRUCTOR, maxLines, maxParams);
    }
  }
  return { violations, checked };
}

// One entry, two limits: a constructor skips the line check (upstream
// checks constructors for parameters only), everything over the param
// count is flagged at the method's start line.
function pushSize(out, rel, m, isConstructor, maxLines, maxParams) {
  if (!isConstructor) {
    const lines = m.endLine - m.startLine + 1;
    if (lines > maxLines) {
      out.push({ file: rel, line: m.startLine, message: `${m.name} has ${lines} lines > max ${maxLines}` });
    }
  }
  const params = m.node.params.length;
  if (params > maxParams) {
    out.push({ file: rel, line: m.startLine, message: `${m.name} has ${params} params > max ${maxParams}` });
  }
}

/**
 * One-line summary: `N violations in M methods over their size limits` on
 * violations, `M methods within their size limits` otherwise.
 */
export function methodSizeSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} methods within their size limits`
    : `${violations} violations in ${checked} methods over their size limits`;
}

/**
 * Parse `method-size` arguments into `{ maxLines, maxParams, paths }`.
 * Unknown flags and non-integer limits are usage errors.
 *
 * @param {string[]} argv
 */
export function parseMethodSizeArgs(argv) {
  const opts = { maxLines: MAX_LINES, maxParams: MAX_PARAMS, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, GATE_FLAGS, NUMBER_FLAGS);
  }
  if (!Number.isInteger(opts.maxLines)) throw new Error(`--max-lines must be an integer: ${opts.maxLines}`);
  if (!Number.isInteger(opts.maxParams)) throw new Error(`--max-params must be an integer: ${opts.maxParams}`);
  return opts;
}

/**
 * The `method-size` command body. Returns exit code 2 iff violations exist.
 */
export function runMethodSize(argv, ctx) {
  const opts = parseMethodSizeArgs(argv);
  return runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    (files, root) => methodSizeViolations(files, root, opts),
    methodSizeSummary,
    'method-size',
  );
}
