// `nesting` subcommand: fails functions whose maximum control-flow nesting
// level exceeds 5. Port of crap4dart's nesting gate (0.5.x). The function
// body counts as level 1; every nested control-flow construct
// (if/for/while/do-while/switch/try) adds one level. Deep nesting is a
// typical artifact of dodging the complexity check with early returns.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gateFiles, toRelPath } from './files.js';
import { runCheck } from './gateCommon.js';
import { childrenOf, extractMethodsWithNodes, isNode } from './complexity.js';

const MAX_NESTING = 5;

const NESTING_TYPES = new Set([
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchStatement',
  'TryStatement',
]);

/**
 * Deepest control-flow nesting of a function body. The body itself is
 * level 1; each nested control-flow construct adds one for its subtree.
 *
 * @param {object} body  the function's body node.
 * @returns {number}
 */
export function maxNesting(body) {
  let max = 1;
  const visit = (n, depth) => {
    if (!isNode(n)) return;
    const d = NESTING_TYPES.has(n.type) ? depth + 1 : depth;
    if (d > max) max = d;
    for (const c of childrenOf(n)) visit(c, d);
  };
  visit(body, 1);
  return max;
}

/**
 * Nesting violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function nestingViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const m of extractMethodsWithNodes(source, { ext: path.extname(file) })) {
      checked++;
      const depth = maxNesting(m.node.body);
      if (depth > MAX_NESTING) {
        violations.push({
          file: toRelPath(file, projectRoot),
          line: m.startLine,
          message: `${m.name} nesting=${depth} > max ${MAX_NESTING}`,
        });
      }
    }
  }
  return { violations, checked };
}

/**
 * One-line summary: `N/M methods nested deeper than 5` on violations,
 * `M methods within nesting 5` otherwise.
 */
export function nestingSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} methods within nesting ${MAX_NESTING}`
    : `${violations}/${checked} methods nested deeper than ${MAX_NESTING}`;
}

/**
 * The `nesting` command body. Returns exit code 2 iff violations exist.
 */
export function runNesting(paths, ctx) {
  return runCheck(ctx, gateFiles(paths, ctx.cwd), nestingViolations, nestingSummary);
}
