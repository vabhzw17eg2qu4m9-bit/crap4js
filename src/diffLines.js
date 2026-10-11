// Changed-line map for diff-scoped gate runs, port of crap4dart 8228585's
// lib/src/files/diff_parser.dart (spec §11.22): parses `git diff
// --unified=0` output into per-file sets of added/changed line numbers and
// answers whether a line range intersects them. Keys are project-relative
// paths of the new file versions; deleted files are absent.

import { spawnSync } from 'node:child_process';

/**
 * Parses unified diff output (with `--unified=0` hunks) into a map of
 * project-relative new path → set of added/changed 1-based line numbers.
 *
 * @param {string} raw
 * @returns {Map<string, Set<number>>}
 */
export function parseDiffLineMap(raw) {
  const added = new Map();
  let current = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ ')) {
      const header = line.slice(4).trim();
      current = header === '/dev/null' ? null : stripBPrefix(header);
    } else if (line.startsWith('@@ ')) {
      addHunk(added, current, line);
    }
  }
  return added;
}

function stripBPrefix(header) {
  return header.startsWith('b/') ? header.slice(2) : header;
}

// Adds the hunk's added-line range (`@@ -l,c +l,c @@`; count defaults to 1).
function addHunk(added, current, line) {
  if (!current) return;
  const match = /\+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return;
  let lines = added.get(current);
  if (!lines) {
    lines = new Set();
    added.set(current, lines);
  }
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  for (let i = 0; i < count; i++) lines.add(start + i);
}

/**
 * Whether any line in [startLine, endLine] of `rel` was added/changed.
 * A file outside the diff never intersects (used to select the methods
 * touched by a diff-scoped run).
 */
export function diffIntersects(added, rel, startLine, endLine) {
  const lines = added.get(rel);
  if (!lines) return false;
  for (const line of lines) {
    if (line >= startLine && line <= endLine) return true;
  }
  return false;
}

/**
 * Runs `git diff --unified=0 <ref> -- <paths...>` (fixed argv, no shell)
 * in `cwd` and parses the result. Throws when git fails (not a
 * repository, unknown ref) — the CLI surfaces that as a usage error.
 *
 * @param {string} ref
 * @param {string[]} relPaths  project-relative paths to scope the diff to
 * @param {string} cwd
 * @param {Function} [spawn]   injectable for tests
 * @returns {Map<string, Set<number>>}
 */
export function gitChangedLines(ref, relPaths, cwd, spawn = spawnSync) {
  const result = spawn('git', ['diff', '--unified=0', ref, '--', ...relPaths], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git diff ${ref} failed: ${(result.stderr ?? '').trim()}`);
  }
  return parseDiffLineMap(result.stdout);
}
