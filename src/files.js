// Source-file discovery: walk src/, detect git-changed files, expand CLI paths.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs']);
const CHANGE_STATUS = new Set(['M', 'A', 'R', 'C', '?']);

/**
 * Recursively walk <root>/src/ for JavaScript source files (.js/.mjs/.cjs).
 * Returns absolute paths, sorted.
 */
export function findSourceFiles(projectRoot) {
  return walkSourceDir(path.join(projectRoot, 'src'));
}

/**
 * Detect git-changed (modified/added/untracked/renamed/copied) source files
 * under <projectRoot>/src/. Deletions are skipped. Returns absolute paths.
 */
export function changedFiles(projectRoot) {
  const result = spawnSync(
    'git',
    ['-C', projectRoot, 'status', '--porcelain'],
    { encoding: 'utf8' },
  );
  if (result.error) {
    throw new Error(`git status failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git status failed: ${(result.stderr || '').trim()}`);
  }

  const srcDir = path.join(projectRoot, 'src');
  const files = new Set();
  for (const line of result.stdout.split('\n')) {
    const resolved = parseStatusLine(line, projectRoot, srcDir);
    if (resolved) files.add(resolved);
  }
  return [...files].sort();
}

/**
 * Parse one `git status --porcelain` line into the resolved absolute source
 * path under <srcDir/>, or null when the line should be skipped: blank/short
 * lines, no change-status indicator (deletions, unchanged), non-source
 * extension, or paths resolving outside src/.
 */
export function parseStatusLine(line, projectRoot, srcDir) {
  const rel = relativePath(line);
  if (!rel) return null;
  const resolved = path.resolve(projectRoot, rel);
  return inSrc(resolved, srcDir) ? resolved : null;
}

/**
 * True for the porcelain status letters that mark a file as added/modified/
 * renamed/copied/untracked. Space (unchanged) and D (deleted) are excluded.
 */
export function isChangeStatus(c) {
  return CHANGE_STATUS.has(c);
}

function relativePath(line) {
  if (!line || line.length < 4) return null;
  if (!isChangeStatus(line[0]) && !isChangeStatus(line[1])) return null;
  const finalPath = renameTarget(line.slice(3).trim());
  return SOURCE_EXTS.has(path.extname(finalPath)) ? finalPath : null;
}

function inSrc(resolved, srcDir) {
  const rel = path.relative(srcDir, resolved);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Expand a mix of file and directory args into a sorted, deduped list of
 * absolute source-file paths. Files are kept as-is; directories are walked.
 */
export function expandPaths(args, projectRoot) {
  const result = new Set();
  for (const arg of args) {
    const p = path.resolve(projectRoot, arg);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const f of walkSourceDir(p)) result.add(f);
    } else if (st.isFile() && SOURCE_EXTS.has(path.extname(p))) {
      result.add(p);
    }
  }
  return [...result].sort();
}

function walkSourceDir(dir) {
  const out = [];
  for (const e of readEntries(dir)) {
    if (e === 'node_modules') continue;
    const p = path.join(dir, e);
    const st = statOrSkip(p);
    if (st?.isDirectory()) out.push(...walkSourceDir(p));
    else if (isSourceFile(e, st)) out.push(p);
  }
  return out.sort();
}

function readEntries(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statOrSkip(p) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

function isSourceFile(name, st) {
  return st?.isFile() && SOURCE_EXTS.has(path.extname(name));
}

function renameTarget(pathPart) {
  const idx = pathPart.indexOf(' -> ');
  return idx < 0 ? pathPart : pathPart.slice(idx + 4);
}
