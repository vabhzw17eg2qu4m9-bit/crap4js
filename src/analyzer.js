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
 * @returns {Array<object>} Sorted MethodMetric array.
 */
export function analyze({ filePaths, coveragePath, projectRoot }) {
  const warn = (msg) => process.stderr.write(`Warning: ${msg}\n`);
  const coverageMap = loadCoverageMap(coveragePath, projectRoot, warn);

  const metrics = [];
  for (const file of filePaths) {
    metrics.push(...analyzeFile(file, projectRoot, coverageMap, warn));
  }

  metrics.sort(compareMetrics);
  return metrics;
}

function loadCoverageMap(coveragePath, projectRoot, warn) {
  if (!coveragePath) return null;
  if (!existsSync(coveragePath)) {
    warn(`coverage file not found at ${coveragePath}. Coverage will be N/A.`);
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
    methods = extractMethods(readFileSync(file, 'utf8'));
  } catch (e) {
    warn(`failed to parse ${rel}: ${e.message}`);
    return [];
  }
  const fileCoverage = coverageMap ? coverageMap.get(rel) : null;
  return methods.map((m) => {
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
