// Istanbul / nyc coverage JSON parsing and per-method attribution.
//
// The Istanbul JSON structure is:
//   { "/abs/path.js": { statementMap: {id: {start:{line,col}, end:{line,col}}},
//                       s: {id: hitCount}, ... } }
// Coverage attribution: for each statement whose [start.line, end.line]
// intersects the method's [startLine, endLine], count it. covered = statements
// with s[id] > 0, total = intersecting statements. Result is covered/total, or
// null when no statements intersect.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Load an Istanbul coverage JSON file and return a map keyed by project-relative
 * file path. Entries outside the project root are ignored.
 *
 * @param {string} filePath     Absolute or relative path to coverage-final.json.
 * @param {string} projectRoot  Absolute project root used to relativise keys.
 * @returns {Map<string, object>}
 */
export function loadCoverage(filePath, projectRoot) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const map = new Map();
  for (const [absPath, data] of Object.entries(raw)) {
    const rel = path.relative(projectRoot, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    map.set(rel.split(path.sep).join('/'), data);
  }
  return map;
}

/**
 * Compute statement coverage for a method's line range.
 *
 * @param {object|null} fileCoverage  Per-file Istanbul data (with statementMap + s).
 * @param {number} startLine          Method start line (1-based, inclusive).
 * @param {number} endLine            Method end line (1-based, inclusive).
 * @returns {number|null}             Fraction in [0, 1], or null when no statements match.
 */
export function coverageForMethod(fileCoverage, startLine, endLine) {
  if (!fileCoverage || !fileCoverage.statementMap) return null;
  let total = 0;
  let covered = 0;
  const hits = fileCoverage.s || {};
  for (const [id, stmt] of Object.entries(fileCoverage.statementMap)) {
    const sLine = stmt.start && stmt.start.line;
    const eLine = stmt.end && stmt.end.line;
    if (sLine == null || eLine == null) continue;
    if (eLine < startLine || sLine > endLine) continue;
    total++;
    if (hits[id] > 0) covered++;
  }
  if (total === 0) return null;
  return covered / total;
}
