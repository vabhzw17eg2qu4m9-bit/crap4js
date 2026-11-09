// `test-coverage` subcommand: fails when the total statement coverage of
// the selected files is below --min-percent (default 80.0). Port of
// crap4dart's coverage_gate with the config flattened to CLI flags and the
// js host's coverage source: the same loaders the CRAP command uses
// (Istanbul JSON, or lcov for a path ending in .info), with the same
// fail-closed semantics — a missing, unparseable, or record-free coverage
// input is an input error (exit 1), never a silent pass. The ratio is the
// statement-hit ratio the CRAP attribution uses: covered / total statements
// over the selected files that have a coverage entry; `--exclude` globs
// drop files before the ratio is computed.

import path from 'node:path';
import { gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { globToRegExp } from './bannedImports.js';
import { DEFAULT_COVERAGE } from './constants.js';
import { loadCoverage } from './coverage.js';

const MIN_PERCENT = 80.0;

const GATE_FLAGS = { '--min-percent': 'minPercent', '--coverage': 'coverage', '--exclude': 'exclude' };
const NUMBER_FLAGS = new Set(['--min-percent']);

/**
 * Total statement coverage of `files` from the coverage report at
 * `coveragePath`. Throws (exit 1) when the input is missing, unparseable,
 * or record-free. `--exclude` has already been applied to `files` by the
 * caller (excluded files never enter the ratio). Files without a coverage
 * entry are skipped — there is no statement inventory to count them
 * against.
 *
 * @param {string[]} files  absolute paths, exclusion applied.
 * @param {string} projectRoot
 * @param {{ coverage?: string, minPercent?: number }} opts
 * @returns {{violations: Array<{file, message}>, checked: number, percent: number}}
 */
export function coverageGateViolations(files, projectRoot, opts) {
  const covPath = path.resolve(projectRoot, opts.coverage || DEFAULT_COVERAGE);
  const coverage = loadCoverageOrThrow(covPath, projectRoot);
  const { percent, checked } = statementRatio(files, coverage, projectRoot);
  const min = opts.minPercent ?? MIN_PERCENT;
  const violations =
    percent < min
      ? [{ file: toRelPath(covPath, projectRoot), message: `total coverage ${fmt(percent)}% < min ${fmt(min)}%` }]
      : [];
  return { violations, checked, percent };
}

// The fail-closed load: missing, unparseable, or record-free coverage is
// an input error (exit 1), never a silent pass.
function loadCoverageOrThrow(covPath, projectRoot) {
  let coverage;
  try {
    coverage = loadCoverage(covPath, projectRoot);
  } catch {
    throw noCoverageData(covPath, projectRoot);
  }
  if (coverage.size === 0) throw noCoverageData(covPath, projectRoot);
  return coverage;
}

// The statement-hit ratio the CRAP attribution uses, aggregated over the
// selection; files without a coverage entry contribute nothing.
function statementRatio(files, coverage, projectRoot) {
  let covered = 0;
  let total = 0;
  let checked = 0;
  for (const file of files) {
    const fc = coverage.get(toRelPath(file, projectRoot));
    if (!fc?.statementMap) continue;
    checked++;
    const hits = fc.s ?? {};
    for (const id of Object.keys(fc.statementMap)) {
      total++;
      if (hits[id] > 0) covered++;
    }
  }
  return { percent: total === 0 ? 100.0 : (covered / total) * 100, checked };
}

function noCoverageData(covPath, projectRoot) {
  return new Error(`no coverage data at ${toRelPath(covPath, projectRoot)}`);
}

// Upstream parity: one decimal place, always (`100` prints as `100.0`).
function fmt(value) {
  return value.toFixed(1);
}

/**
 * One-line summary: `coverage P% >= min M%` on pass, `coverage P% < min M%`
 * on fail. The ratio comes from the single findViolations pass, captured
 * by the caller.
 */
export function coverageGateSummary({ violations }, percent, minPercent = MIN_PERCENT) {
  return `coverage ${fmt(percent)}% ${violations === 0 ? '>=' : '<'} min ${fmt(minPercent)}%`;
}

/**
 * Parse `test-coverage` arguments into `{ minPercent, coverage, exclude,
 * paths }`.
 *
 * @param {string[]} argv
 */
export function parseTestCoverageArgs(argv) {
  const opts = { minPercent: MIN_PERCENT, coverage: DEFAULT_COVERAGE, exclude: [], paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, GATE_FLAGS, NUMBER_FLAGS);
  }
  return opts;
}

/**
 * The `test-coverage` command body. Returns exit code 2 iff the ratio is
 * below the minimum; a missing/empty coverage input exits 1.
 */
export function runTestCoverage(argv, ctx) {
  const opts = parseTestCoverageArgs(argv);
  const files = selectFiles(opts, ctx.cwd);
  if (files.length === 0) {
    ctx.out.write('No source files to check.\n');
    return 0;
  }
  let percent = null;
  return runCheck(
    ctx,
    files,
    (sel, root) => {
      const r = coverageGateViolations(sel, root, opts);
      percent = r.percent;
      return r;
    },
    (r) => coverageGateSummary(r, percent, opts.minPercent),
    'test-coverage',
  );
}

function selectFiles(opts, projectRoot) {
  const globs = opts.exclude.map(globToRegExp);
  return gateFiles(opts.paths, projectRoot).filter((f) => !globs.some((g) => g.test(toRelPath(f, projectRoot))));
}
