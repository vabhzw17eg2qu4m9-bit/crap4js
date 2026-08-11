// `--run-tests` helper: runs the project's test suite with coverage collection
// before analysis. Throws on non-zero exit.

import { spawnSync } from 'node:child_process';

const SHELL = process.platform === 'win32';

/**
 * Run `npx nyc --reporter=json --reporter=text node --test` (or `c8` as a
 * fallback) in the project root. Throws on failure.
 *
 * @param {string} projectRoot
 * @returns {number} exit code (0 on success)
 */
export function runTests(projectRoot) {
  const primary = spawnSync(
    'npx',
    ['nyc', '--reporter=json', '--reporter=text', 'node', '--test'],
    { cwd: projectRoot, stdio: 'inherit', shell: SHELL },
  );
  if (primary.status === 0) return 0;

  const fallback = spawnSync(
    'npx',
    ['c8', '--reporter=json', 'node', '--test'],
    { cwd: projectRoot, stdio: 'inherit', shell: SHELL },
  );
  if (fallback.status === 0) return 0;

  throw new Error(
    `--run-tests failed: nyc exited ${primary.status}, c8 exited ${fallback.status}`,
  );
}
