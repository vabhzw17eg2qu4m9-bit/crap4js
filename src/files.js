// Source-file discovery: walk src/, detect git-changed files, expand CLI paths.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs']);

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
    if (!line || line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    if (!isChangeStatus(x) && !isChangeStatus(y)) continue;

    const finalPath = renameTarget(line.slice(3).trim());
    if (!SOURCE_EXTS.has(path.extname(finalPath))) continue;

    const resolved = path.resolve(projectRoot, finalPath);
    const rel = path.relative(srcDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    files.add(resolved);
  }
  return [...files].sort();
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
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e === 'node_modules') continue;
    const p = path.join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkSourceDir(p));
    } else if (st.isFile() && SOURCE_EXTS.has(path.extname(e))) {
      out.push(p);
    }
  }
  return out.sort();
}

function isChangeStatus(c) {
  return c === 'M' || c === 'A' || c === 'R' || c === 'C' || c === '?';
}

function renameTarget(pathPart) {
  const idx = pathPart.indexOf(' -> ');
  return idx < 0 ? pathPart : pathPart.slice(idx + 4);
}
