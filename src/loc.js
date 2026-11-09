// `loc` subcommand: fails files longer than --max-lines (default 800).
// Port of crap4dart's loc_gate with the config flattened to CLI flags (the
// ports are flags-only). Catches god files that hide split responsibilities;
// per-path entry overrides are an upstream config feature — here one limit
// applies to the whole selection. Line count matches upstream: an empty
// file is 0 lines and a trailing newline does not open a new line.

import { readFileSync } from 'node:fs';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { globToRegExp } from './bannedImports.js';

const MAX_LINES = 800;

const GATE_FLAGS = { '--max-lines': 'maxLines', '--exclude': 'exclude' };
const NUMBER_FLAGS = new Set(['--max-lines']);

/**
 * Physical line count: `split('\n')` with the trailing empty element
 * dropped, so `''` is 0 lines and `'a\n'` is 1.
 *
 * @param {string} content
 * @returns {number}
 */
export function lineCount(content) {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * Loc violations across files. `--exclude` globs (project-relative POSIX
 * paths) remove files from the check entirely — they are not counted.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {{ maxLines?: number, exclude?: string[] }} [opts]
 * @returns {{violations: Array<{file, message}>, checked: number}}
 */
export function locViolations(files, projectRoot, { maxLines = MAX_LINES, exclude = [] } = {}) {
  const globs = exclude.map(globToRegExp);
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const rel = toRelPath(file, projectRoot);
    if (globs.some((g) => g.test(rel))) continue;
    checked++;
    const lines = lineCount(readFileSync(file, UTF8));
    if (lines > maxLines) {
      violations.push({ file: rel, message: `${lines} lines > max ${maxLines}` });
    }
  }
  return { violations, checked };
}

/**
 * One-line summary: `N/M files over <max> lines` on violations,
 * `M files within <max> lines` otherwise.
 */
export function locSummary({ violations, checked }, maxLines = MAX_LINES) {
  return violations === 0
    ? `${checked} files within ${maxLines} lines`
    : `${violations}/${checked} files over ${maxLines} lines`;
}

/**
 * Parse `loc` arguments into `{ maxLines, exclude, paths }`. Unknown flags
 * and non-integer maxima are usage errors.
 *
 * @param {string[]} argv
 */
export function parseLocArgs(argv) {
  const opts = { maxLines: MAX_LINES, exclude: [], paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, GATE_FLAGS, NUMBER_FLAGS);
  }
  if (!Number.isInteger(opts.maxLines)) {
    throw new Error(`--max-lines must be an integer: ${opts.maxLines}`);
  }
  return opts;
}

/**
 * The `loc` command body. Returns exit code 2 iff violations exist.
 */
export function runLoc(argv, ctx) {
  const opts = parseLocArgs(argv);
  return runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    (files, root) => locViolations(files, root, opts),
    (r) => locSummary(r, opts.maxLines),
    'loc',
  );
}
