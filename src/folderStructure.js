// `folder-structure` subcommand: flags directories containing more than
// max_loose_files (default 0) source files DIRECTLY — a flat-file sprawl
// that should be organized into feature packages. Port of crap4dart's
// folder_structure gate (0.9.x); crap4js has no config, so the default
// dir (src, the port's source root) and threshold are baked in. Only
// direct children count — files in subdirectories are the organized form.

import { statSync } from 'node:fs';
import path from 'node:path';
import { looseSourceFiles } from './files.js';

const MAX_LOOSE_FILES = 0;
const DIRS = ['src'];

/**
 * Folder-structure violations for the project.
 *
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, message}>, checked: number}}
 */
export function folderStructureViolations(projectRoot) {
  const violations = [];
  const dirs = DIRS.map((d) => ({ dir: d, abs: path.join(projectRoot, d) })).filter((d) =>
    statSync(d.abs, { throwIfNoEntry: false })?.isDirectory(),
  );
  for (const { dir, abs } of dirs) {
    const loose = looseSourceFiles(abs).length;
    if (loose > MAX_LOOSE_FILES) {
      violations.push({
        file: dir,
        message: `${loose} loose files directly in ${dir} — group them into feature packages (max ${MAX_LOOSE_FILES})`,
      });
    }
  }
  return { violations, checked: dirs.length };
}

/**
 * One-line summary mirroring the Dart gate: `M directories organized into
 * packages`, or `N directory(ies) with loose-file sprawl`.
 */
export function folderStructureSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} directories organized into packages`
    : `${violations} directory(ies) with loose-file sprawl`;
}

/**
 * The `folder-structure` command body. Takes no arguments — any argument
 * is a usage error that throws and surfaces as exit code 1 (the checked
 * directory is the port's source root, not a selection). Returns exit
 * code 2 iff violations exist.
 */
export function runFolderStructure(argv, ctx) {
  const arg = argv[0];
  if (arg) throw new Error(`unknown argument: ${arg}`);
  const { violations, checked } = folderStructureViolations(ctx.cwd);
  for (const v of violations) {
    ctx.out.write(`${v.file}: ${v.message}\n`);
  }
  ctx.out.write(folderStructureSummary({ violations: violations.length, checked }) + '\n');
  return violations.length > 0 ? 2 : 0;
}
