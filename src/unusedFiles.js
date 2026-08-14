// `unused-files` subcommand: flags non-test source files that are never
// imported by any analyzed non-test file. Port of crap4dart's
// unused_files gate (0.5.x), adapted to ESM: relative import specifiers
// are resolved against the importing file's directory (trying source
// extensions and `/index.<ext>`); bare specifiers name external packages
// and never count.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gateFiles, toRelPath } from './files.js';
import { runCheck, skipPartialSelection } from './gateCommon.js';
import { parseSource } from './complexity.js';
import { collectImports, resolveImport } from './imports.js';

/**
 * Unused-file violations across files.
 *
 * @param {string[]} files  absolute paths (non-test sources).
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, message}>, checked: number}}
 */
export function unusedFilesViolations(files, projectRoot) {
  const imported = new Set();
  for (const file of files) {
    const ast = parseSource(readFileSync(file, 'utf8'), path.extname(file));
    for (const spec of collectImports(ast.program)) {
      const resolved = resolveImport(spec, file, projectRoot);
      if (resolved) imported.add(resolved);
    }
  }
  const violations = files
    .map((f) => toRelPath(f, projectRoot))
    .filter((rel) => !imported.has(rel))
    .map((rel) => ({ file: rel, message: 'never imported by any analyzed source file' }));
  return { violations, checked: files.length };
}

/**
 * One-line summary: `N/M files never imported` on violations, `M files
 * all imported` otherwise.
 */
export function unusedFilesSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} files all imported`
    : `${violations}/${checked} files never imported`;
}

/**
 * The `unused-files` command body. A whole-project check: with an explicit
 * path selection it prints the skip message and exits 0 (a partial file
 * set yields false positives — crap4dart 0.5.1 behavior).
 */
export function runUnusedFiles(paths, ctx) {
  if (paths.length > 0) return skipPartialSelection(ctx);
  return runCheck(ctx, gateFiles([], ctx.cwd), unusedFilesViolations, unusedFilesSummary);
}
