// Orchestrates parsing + coverage attribution to produce MethodMetric[].
//
// MethodMetric = {
//   methodName: string,
//   file: string,          // project-relative
//   startLine: number,     // kept for stable tie-breaking
//   complexity: number,
//   coverage: number|null, // fraction [0,1]
//   crapScore: number|null
// }

import { UTF8, toRelPath } from './files.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractMethods } from './complexity.js';
import { loadCoverage, coverageForMethod } from './coverage.js';
import { diffIntersects } from './diffLines.js';
import { crapScore } from './crapScore.js';

/**
 * Analyze a set of source files, combining complexity and coverage.
 *
 * @param {{ filePaths: string[], coveragePath: string|null, projectRoot: string, metric?: string, strict?: boolean, diffLines?: Map<string, Set<number>> }} opts
 *   `metric` selects the complexity scoring: `cyclomatic` (default) or
 *   `cognitive` (SonarSource v1.2); the chosen value feeds the CRAP formula.
 *   `strict` turns the coverage fail-open warnings into thrown errors and
 *   treats a selected file with no coverage entry as 0.0% covered.
 *   `diffLines` (a parseDiffLineMap result) restricts the report to the
 *   functions whose line range intersects an added/changed line; files with
 *   no intersecting function contribute nothing.
 * @returns {{ metrics: Array<object>, parseFailures: string[] }}
 *   Sorted MethodMetric array plus relative paths of files that failed to parse.
 */
export function analyze({ filePaths, coveragePath, projectRoot, metric, strict, diffLines }) {
  const warn = (msg) => process.stderr.write(`Warning: ${msg}\n`);
  const coverageMap = loadCoverageMap(coveragePath, projectRoot, warn, strict);
  const fileOpts = { metric, strict, diffLines };

  const metrics = [];
  const parseFailures = [];
  for (const file of filePaths) {
    const { metrics: fileMetrics, failures } = analyzeFile(
      file,
      projectRoot,
      coverageMap,
      warn,
      fileOpts,
    );
    metrics.push(...fileMetrics);
    parseFailures.push(...failures);
  }

  metrics.sort(compareMetrics);
  return { metrics, parseFailures };
}

function loadCoverageMap(coveragePath, projectRoot, warn, strict) {
  if (!coveragePath) return null;
  if (!existsSync(coveragePath)) {
    return failCoverage(
      strict,
      warn,
      `coverage file not found at ${coveragePath}. Coverage will be N/A. ` +
        'Generate it with `npx c8 --reporter=json node --test`.',
    );
  }
  let map;
  try {
    map = loadCoverage(coveragePath, projectRoot);
  } catch (e) {
    return failCoverage(strict, warn, `failed to parse coverage file ${coveragePath}: ${e.message}`);
  }
  if (strict && map.size === 0) {
    throw new Error(`coverage file has no records for this project: ${coveragePath}`);
  }
  return map;
}

// In strict mode a coverage problem is a gate failure (the caller's tryStep
// turns the throw into exit 1); otherwise it degrades to a warning.
function failCoverage(strict, warn, message) {
  if (strict) throw new Error(message);
  warn(message);
  return null;
}

// Diff-scoped runs keep only the functions whose line range intersects an
// added/changed line; a file whose functions all miss the diff selects
// nothing (null), so it contributes no metrics at all.
function inDiffSelection(diffLines, rel, methods) {
  if (!diffLines) return methods;
  const selected = methods.filter((m) => diffIntersects(diffLines, rel, m.startLine, m.endLine));
  return selected.length === 0 ? null : selected;
}

function analyzeFile(file, projectRoot, coverageMap, warn, opts) {
  const rel = toRelPath(file, projectRoot);
  let methods;
  try {
    methods = extractMethods(readFileSync(file, UTF8), {
      ext: path.extname(file),
      metric: opts.metric,
    });
  } catch (e) {
    warn(`failed to parse ${rel}: ${e.message}`);
    return { metrics: [], failures: [rel] };
  }
  methods = inDiffSelection(opts.diffLines, rel, methods);
  if (methods === null) return { metrics: [], failures: [] };
  const fileCoverage = coverageMap ? coverageMap.get(rel) : null;
  // Strict + no entry for a selected file: every function counts as 0.0%
  // covered (CRAP computed) instead of N/A. A file WITH an entry keeps the
  // no-intersecting-statements N/A for type-only functions.
  const uncovered = opts.strict && coverageMap && !coverageMap.has(rel);
  const metrics = methods.map((m) => {
    const coverage = uncovered ? 0 : coverageForMethod(fileCoverage, m.startLine, m.endLine);
    return {
      methodName: m.name,
      file: rel,
      startLine: m.startLine,
      complexity: m.complexity,
      coverage,
      crapScore: crapScore(m.complexity, coverage),
    };
  });
  return { metrics, failures: [] };
}

export function compareMetrics(a, b) {
  const aNull = a.crapScore == null;
  const bNull = b.crapScore == null;
  if (aNull && bNull) return tieBreak(a, b);
  if (aNull) return 1;
  if (bNull) return -1;
  if (b.crapScore !== a.crapScore) return b.crapScore - a.crapScore;
  return tieBreak(a, b);
}

function tieBreak(a, b) {
  // `<` vs `<=` is mutation-equivalent here: the ternary evaluates only
  // after the `!==` guard, so the files always differ when it runs
  // (mutation-verified — both spellings pass the full suite).
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.startLine - b.startLine;
}
