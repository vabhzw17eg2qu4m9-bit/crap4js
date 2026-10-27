// `--run-tests` helper: runs the project's test suite with coverage collection
// before analysis. Throws on non-zero exit.

import { TEST_FLAG } from './constants.js';
import { spawnSync } from 'node:child_process';

const SHELL = process.platform === 'win32';

const COMMANDS = [
  ['npx', ['nyc', '--reporter=json', '--reporter=text', 'node', TEST_FLAG]],
  ['npx', ['c8', '--reporter=json', 'node', TEST_FLAG]],
];

/**
 * Run `npx nyc --reporter=json --reporter=text node --test` (or `c8` as a
 * fallback) in the project root. Throws when both fail.
 *
 * @param {string} projectRoot
 * @returns {number} exit code (0 on success)
 */
export function runTests(projectRoot) {
  const opts = { cwd: projectRoot, stdio: 'inherit', shell: SHELL };
  const ok = COMMANDS.some(([cmd, args]) => spawnSync(cmd, args, opts).status === 0);
  if (!ok) {
    throw new Error('--run-tests failed: nyc and c8 both exited non-zero');
  }
  return 0;
}
