// `unused-code` subcommand: flags module-scope declarations that are
// never referenced anywhere else in their module — non-exported function
// declarations, class declarations, and const/let/var declarators whose
// identifier appears nowhere else. Port of crap4dart's unused_code gate
// (0.5.x), adapted to ESM visibility: only non-exported bindings are
// module-private. References are counted lexically on unresolved ASTs,
// which keeps the check conservative. Test files are excluded entirely —
// both their declarations and their references.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gateFiles, toRelPath } from './files.js';
import { runCheck, skipPartialSelection } from './gateCommon.js';
import { childrenOf, isNode, parseSource } from './complexity.js';

/**
 * Unused-declaration violations across files.
 *
 * @param {string[]} files  absolute paths (non-test sources).
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function unusedCodeViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const ast = parseSource(readFileSync(file, 'utf8'), path.extname(file));
    const { declarations, counts } = scanModule(ast.program);
    for (const d of declarations) {
      checked++;
      if (counts.get(d.name) === 1) {
        violations.push({
          file: toRelPath(file, projectRoot),
          line: d.line,
          message: `${d.name} is never referenced in the module`,
        });
      }
    }
  }
  return { violations, checked };
}

// Module-scope private declarations and a lexical count of every
// identifier occurrence in the module.
function scanModule(program) {
  const counts = new Map();
  countIdentifiers(program, counts);
  const declarations = [];
  for (const stmt of program.body) {
    declarations.push(...moduleDeclarationsOf(stmt));
  }
  return { declarations, counts };
}

// Module-scope declaration forms; export wrappers are handled separately.
const MODULE_DECLARATIONS = {
  FunctionDeclaration: namedDeclaration,
  ClassDeclaration: namedDeclaration,
  VariableDeclaration: variableDeclarations,
};

// Declarations at module scope that are NOT exported (module-private).
function moduleDeclarationsOf(stmt) {
  if (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') {
    return [];
  }
  return MODULE_DECLARATIONS[stmt.type]?.(stmt) ?? [];
}

function namedDeclaration(stmt) {
  return stmt.id ? [{ name: stmt.id.name, line: stmt.loc.start.line }] : [];
}

function variableDeclarations(stmt) {
  return stmt.declarations
    .filter((d) => d.id.type === 'Identifier')
    .map((d) => ({ name: d.id.name, line: d.loc.start.line }));
}

function countIdentifiers(n, counts) {
  if (!isNode(n)) return;
  if (n.type === 'Identifier') {
    counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
  }
  for (const c of childrenOf(n)) countIdentifiers(c, counts);
}

/**
 * One-line summary: `N unused declarations` on violations, `M
 * declarations all referenced` otherwise.
 */
export function unusedCodeSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} declarations all referenced`
    : `${violations} unused declarations in ${checked} module-scope declarations`;
}

/**
 * The `unused-code` command body. A whole-project check: with an explicit
 * path selection it prints the skip message and exits 0 (a partial file
 * set yields false positives — crap4dart 0.5.1 behavior).
 */
export function runUnusedCode(paths, ctx) {
  if (paths.length > 0) return skipPartialSelection(ctx);
  return runCheck(ctx, gateFiles([], ctx.cwd), unusedCodeViolations, unusedCodeSummary);
}
