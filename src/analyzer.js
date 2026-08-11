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

  let coverageMap = null;
  if (coveragePath) {
    if (existsSync(coveragePath)) {
      try {
        coverageMap = loadCoverage(coveragePath, projectRoot);
      } catch (e) {
        warn(`failed to parse coverage file ${coveragePath}: ${e.message}`);
      }
    } else {
      warn(`coverage file not found at ${coveragePath}. Coverage will be N/A.`);
    }
  }

  const metrics = [];
  for (const file of filePaths) {
    const source = readFileSync(file, 'utf8');
    const rel = path.relative(projectRoot, file).split(path.sep).join('/');
    let methods;
    try {
      methods = extractMethods(source);
    } catch (e) {
      warn(`failed to parse ${rel}: ${e.message}`);
      continue;
    }
    const fileCoverage = coverageMap ? coverageMap.get(rel) : null;
    for (const m of methods) {
      const coverage = coverageForMethod(fileCoverage, m.startLine, m.endLine);
      metrics.push({
        methodName: m.name,
        file: rel,
        startLine: m.startLine,
        complexity: m.complexity,
        coverage,
        crapScore: crapScore(m.complexity, coverage),
      });
    }
  }

  metrics.sort(compareMetrics);
  return metrics;
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
