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

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractMethods } from './complexity.js';
import { loadCoverage, coverageForMethod } from './coverage.js';
import { crapScore } from './crapScore.js';

/**
 * Analyze a set of source files, combining complexity and coverage.
 *
 * @param {{ filePaths: string[], coveragePath: string|null, projectRoot: string }} opts
 * @returns {{ metrics: Array<object>, parseFailures: string[] }}
 *   Sorted MethodMetric array plus relative paths of files that failed to parse.
 */
export function analyze({ filePaths, coveragePath, projectRoot }) {
  const warn = (msg) => process.stderr.write(`Warning: ${msg}\n`);
  const coverageMap = loadCoverageMap(coveragePath, projectRoot, warn);

  const metrics = [];
  const parseFailures = [];
  for (const file of filePaths) {
    const { metrics: fileMetrics, failures } = analyzeFile(
      file,
      projectRoot,
      coverageMap,
      warn,
    );
    metrics.push(...fileMetrics);
    parseFailures.push(...failures);
  }

  metrics.sort(compareMetrics);
  return { metrics, parseFailures };
}

function loadCoverageMap(coveragePath, projectRoot, warn) {
  if (!coveragePath) return null;
  if (!existsSync(coveragePath)) {
    warn(
      `coverage file not found at ${coveragePath}. Coverage will be N/A. ` +
        'Generate it with `npx c8 --reporter=json node --test`.',
    );
    return null;
  }
  try {
    return loadCoverage(coveragePath, projectRoot);
  } catch (e) {
    warn(`failed to parse coverage file ${coveragePath}: ${e.message}`);
    return null;
  }
}

function analyzeFile(file, projectRoot, coverageMap, warn) {
  const rel = path.relative(projectRoot, file).split(path.sep).join('/');
  let methods;
  try {
    methods = extractMethods(readFileSync(file, 'utf8'), {
      ext: path.extname(file),
    });
  } catch (e) {
    warn(`failed to parse ${rel}: ${e.message}`);
    return { metrics: [], failures: [rel] };
  }
  const fileCoverage = coverageMap ? coverageMap.get(rel) : null;
  const metrics = methods.map((m) => {
    const coverage = coverageForMethod(fileCoverage, m.startLine, m.endLine);
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
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.startLine - b.startLine;
}
