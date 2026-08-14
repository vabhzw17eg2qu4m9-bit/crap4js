// `class-size` subcommand: fails classes with more than 25 concrete
// methods or a weighted-methods-per-class sum (total cyclomatic complexity
// over all methods) above 80. Port of crap4dart's class_size gate (0.5.x).
// Catches god-classes assembled from many small methods that pass the
// complexity check individually.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gateFiles, toRelPath } from './files.js';
import { runCheck } from './gateCommon.js';
import { childrenOf, computeComplexity, isNode, parseSource } from './complexity.js';

const MAX_METHODS = 25;
const MAX_WMC = 80;

const CLASS_TYPES = new Set(['ClassDeclaration', 'ClassExpression']);
const METHOD_TYPES = new Set(['ClassMethod', 'ClassPrivateMethod']);

/**
 * Concrete-method count and WMC for every class declared in a parsed
 * program (nested classes included, attributed to their own class).
 *
 * @param {object} program  parsed Program node.
 * @returns {Array<{name: string, line: number, methods: number, wmc: number}>}
 */
export function classTotals(program) {
  const totals = [];
  const visit = (n) => {
    if (!isNode(n)) return;
    if (CLASS_TYPES.has(n.type)) totals.push(totalsOf(n));
    for (const c of childrenOf(n)) visit(c);
  };
  visit(program);
  return totals;
}

// Direct-body members only — methods of nested classes belong to the
// nested class, which the outer walk visits as its own entry.
function totalsOf(cls) {
  let methods = 0;
  let wmc = 0;
  for (const m of cls.body?.body ?? []) {
    if (!METHOD_TYPES.has(m.type) || m.kind === 'constructor' || !m.body) continue;
    methods++;
    wmc += computeComplexity(m.body);
  }
  return {
    name: cls.id?.name ?? '<anonymous>',
    line: cls.loc.start.line,
    methods,
    wmc,
  };
}

/**
 * Class-size violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function classSizeViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const ast = parseSource(readFileSync(file, 'utf8'), path.extname(file));
    for (const t of classTotals(ast.program)) {
      checked++;
      pushOverlaps(t, violations, toRelPath(file, projectRoot));
    }
  }
  return { violations, checked };
}

function pushOverlaps(t, violations, file) {
  if (t.methods > MAX_METHODS) {
    violations.push({
      file,
      line: t.line,
      message: `${t.name} has ${t.methods} methods > max ${MAX_METHODS}`,
    });
  }
  if (t.wmc > MAX_WMC) {
    violations.push({
      file,
      line: t.line,
      message: `${t.name} WMC=${t.wmc} > max ${MAX_WMC}`,
    });
  }
}

/**
 * One-line summary: `N violations in M classes over 25 methods/WMC 80`
 * on violations, `M classes within 25 methods/WMC 80` otherwise.
 */
export function classSizeSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} classes within ${MAX_METHODS} methods/WMC ${MAX_WMC}`
    : `${violations} violations in ${checked} classes over ${MAX_METHODS} methods/WMC ${MAX_WMC}`;
}

/**
 * The `class-size` command body. Returns exit code 2 iff violations exist.
 */
export function runClassSize(paths, ctx) {
  return runCheck(ctx, gateFiles(paths, ctx.cwd), classSizeViolations, classSizeSummary);
}
