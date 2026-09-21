// Istanbul / nyc coverage JSON parsing and per-method attribution.
//
// The Istanbul JSON structure is:
//   { "/abs/path.js": { statementMap: {id: {start:{line,col}, end:{line,col}}},
//                       s: {id: hitCount}, ... } }
// Coverage attribution: for each statement whose [start.line, end.line]
// intersects the method's [startLine, endLine], count it. covered = statements
// with s[id] > 0, total = intersecting statements. Result is covered/total, or
// null when no statements intersect.

import { readFileSync, realpathSync } from 'node:fs';
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
  const canonicalRoot = realpathOrSelf(projectRoot);
  const map = new Map();
  const exact = new Set();
  for (const [absPath, data] of Object.entries(raw)) {
    const direct = toProjectRelative(absPath, projectRoot);
    if (direct !== null) {
      map.set(direct, data);
      exact.add(direct);
      continue;
    }
    // An aliased key must never displace one that already matched literally:
    // the two spellings can name the same file with different hit counts, and
    // the literal one is what the analyzer will ask for.
    for (const aliased of throughCanonicalRoot(absPath, canonicalRoot)) {
      if (!exact.has(aliased)) map.set(aliased, data);
    }
  }
  return map;
}

/**
 * Project-relative form of `absPath`, or null when it lies outside the root.
 * Purely lexical — no filesystem access, so the caller's spelling survives.
 */
function toProjectRelative(absPath, root) {
  const rel = path.relative(root, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Every project-relative spelling of a key whose root is written differently
 * from the one in hand; empty when no ancestor of the key is the project root.
 *
 * Coverage keys are absolute paths written by whatever ran the tests, and they
 * need not spell the root the way `process.cwd()` does: a checkout reached
 * through a symlink resolves to a different prefix for the same file, which is
 * the ordinary case on macOS, where the temporary directory is reached through
 * /var and reported as /private/var. Left unmatched, every entry looks
 * external, the map comes back empty, and — because a report of all N/A is
 * defined to have a maximum of 0.0 — the gate exits 0 precisely when its input
 * was misaligned.
 *
 * Only the root prefix is canonicalised. Ancestors are resolved one level at a
 * time, and everything below a matching ancestor keeps the spelling it was
 * given: resolving further would rewrite a symlinked source file, or a
 * symlinked directory above it, to its target — a path the analyzer, which
 * reports what it walked, never asks about.
 *
 * The walk does not stop at the first match. A directory inside the project
 * can resolve to the project root itself, and which of the resulting spellings
 * the analyzer asks for depends on the path it was handed, which is not
 * knowable here. Every candidate names the same file, so all of them are
 * offered and the caller keeps whichever it needs.
 */
function throughCanonicalRoot(absPath, canonicalRoot) {
  const suffix = [path.basename(absPath)];
  const candidates = [];
  let dir = path.dirname(absPath);
  for (;;) {
    if (realpathOrSelf(dir) === canonicalRoot) candidates.push(suffix.join('/'));
    const parent = path.dirname(dir);
    if (parent === dir) return candidates; // reached the filesystem root
    suffix.unshift(path.basename(dir));
    dir = parent;
  }
}

/**
 * Resolved path, or the input when it cannot be resolved. A directory that is
 * absent from this machine (coverage produced elsewhere) is not an error: it
 * simply cannot equal the root, so the walk carries on to the next ancestor,
 * which may still match.
 */
function realpathOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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
  const hits = fileCoverage.s || {};
  const ids = intersectingStatements(fileCoverage.statementMap, startLine, endLine);
  if (ids.length === 0) return null;
  const covered = ids.filter((id) => hits[id] > 0).length;
  return covered / ids.length;
}

function intersectingStatements(statementMap, startLine, endLine) {
  const out = [];
  for (const [id, stmt] of Object.entries(statementMap)) {
    const sLine = stmt?.start?.line;
    const eLine = stmt?.end?.line;
    if (sLine == null || eLine == null) continue;
    if (eLine >= startLine && sLine <= endLine) out.push(id);
  }
  return out;
}
