// Source-file discovery: walk src/, detect git-changed files, expand CLI paths.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
const CHANGE_STATUS = new Set(['M', 'A', 'R', 'C', '?']);

// Colocated test files — excluded so they don't pollute the production metric.
const TEST_FILE_RE = /\.(spec|test)\.(js|jsx|ts|tsx)$/;

/**
 * Recursively walk <root>/src/ for JavaScript source files
 * (.js/.mjs/.cjs/.jsx/.ts/.tsx), excluding test files.
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
  return isSourcePath(finalPath) ? finalPath : null;
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
    } else if (isSourceFile(p, st)) {
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
    else if (isSourceFile(p, st)) out.push(p);
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

/**
 * True for colocated test files: `*.spec.{js,jsx,ts,tsx}`, `*.test.{...}`,
 * and anything under a `__tests__/` directory. Used to keep the production
 * CRAP metric clean.
 */
export function isTestFile(p) {
  return TEST_FILE_RE.test(p) || p.split(path.sep).join('/').includes('/__tests__/');
}

// True for colocated test files and anything under a test/tests/__tests__
// directory segment (checked on directory names only, so src/testing.js
// stays a normal source file). Shared by the gate-check subcommands.
export function isTestPath(p) {
  const norm = String(p).split(path.sep).join('/');
  return isTestFile(norm) || /(^|\/)(test|tests)\//.test(norm);
}

// Files a gate-check subcommand applies to: explicit CLI paths (expanded)
// or the default src/ walk — test files and test directories excluded.
export function gateFiles(paths, projectRoot) {
  const files =
    paths.length > 0 ? expandPaths(paths, projectRoot) : findSourceFiles(projectRoot);
  return files.filter((f) => !isTestPath(f));
}

// Project-relative POSIX path (forward slashes) for report lines.
export function toRelPath(file, projectRoot) {
  return path.relative(projectRoot, file).split(path.sep).join('/');
}

// A path is source if it has a source extension and is not a test file.
function isSourcePath(p) {
  return SOURCE_EXTS.has(path.extname(p)) && !isTestFile(p);
}

function isSourceFile(filePath, st) {
  return st?.isFile() && isSourcePath(filePath);
}

function renameTarget(pathPart) {
  const idx = pathPart.indexOf(' -> ');
  return idx < 0 ? pathPart : pathPart.slice(idx + 4);
}
