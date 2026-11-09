// `public-docs` subcommand: fails exported declarations lacking an adjacent
// JSDoc (`/** ... */`) block. Port of crap4dart's public_docs gate with the
// JS host conventions: the public API surface is the exported one (the
// same notion unused-code uses — non-exported bindings are module-private),
// and dartdoc becomes JSDoc.
//
// Checked: exported function declarations and function-valued
// `export const` declarators, exported classes, and the public methods of
// exported classes (getters/setters included, static included). Exempt:
// constructors (not part of the documented API surface upstream), private
// `#` methods, and methods with computed/string keys — nothing a comment
// above can clearly address. A JSDoc counts only when the block comment
// ends on the line directly above the declaration (a `//` line or blank
// line in between breaks the adjacency).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { globToRegExp } from './bannedImports.js';
import {
  ARROW_FUNCTION_EXPRESSION,
  CONSTRUCTOR,
  EXPORT_NAMED_DECLARATION,
  FUNCTION_EXPRESSION,
  IDENT,
  parseSource,
} from './complexity.js';

const GATE_FLAGS = { '--exclude': 'exclude' };

const CLASS_METHOD_TYPES = new Set(['ClassMethod', 'ClassPrivateMethod']);
const FUNCTION_LIKE = new Set([FUNCTION_EXPRESSION, ARROW_FUNCTION_EXPRESSION]);

/**
 * Public-docs violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {{ exclude?: string[] }} [opts]
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function publicDocsViolations(files, projectRoot, { exclude = [] } = {}) {
  const globs = exclude.map(globToRegExp);
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const rel = toRelPath(file, projectRoot);
    if (globs.some((g) => g.test(rel))) continue;
    const ast = parseFile(file);
    const state = { comments: ast.comments ?? [], rel, violations, checked: 0 };
    for (const stmt of ast.program.body) {
      // Only export wrappers name public API: an exported statement is
      // checked through its inline declaration; a bare `export { a }` list
      // has none and names nothing here.
      if (stmt.type === EXPORT_NAMED_DECLARATION || stmt.type === 'ExportDefaultDeclaration') {
        if (stmt.declaration) collectExported(stmt.declaration, state);
      }
    }
    checked += state.checked;
  }
  return { violations, checked };
}

function parseFile(file) {
  // @babel/parser collects every comment on ast.comments.
  return parseSource(readFileSync(file, UTF8), path.extname(file));
}

// One exported-declaration form per handler — functions (named function
// declarations and function-valued declarators), classes (plus their
// public methods); every other exported form names nothing to check.
const EXPORT_HANDLERS = {
  FunctionDeclaration(decl, state) {
    if (decl.id) checkDocs(decl, decl.id.name, 'function', state);
  },
  ClassDeclaration(decl, state) {
    if (!decl.id) return;
    checkDocs(decl, decl.id.name, 'class', state);
    for (const member of decl.body?.body ?? []) checkMethod(member, state);
  },
  VariableDeclaration(decl, state) {
    for (const d of decl.declarations) {
      // `export const f = () => {}` — an exported function in the modern
      // style; the docs go above the `export const` statement.
      if (d.id?.type === IDENT && FUNCTION_LIKE.has(d.init?.type)) {
        checkDocs(d.init, d.id.name, 'function', state, decl.loc.start.line);
      }
    }
  },
};

function collectExported(decl, state) {
  EXPORT_HANDLERS[decl.type]?.(decl, state);
}

// Public methods of an exported class: every named non-constructor class
// method with a plain identifier key (`#` private methods and computed/
// string keys are exempt).
function checkMethod(member, state) {
  if (!CLASS_METHOD_TYPES.has(member.type)) return;
  if (member.kind === CONSTRUCTOR) return;
  if (member.key?.type !== IDENT) return;
  checkDocs(member, member.key.name, 'method', state);
}

function checkDocs(node, name, kind, state, line = node.loc.start.line) {
  state.checked++;
  if (!hasAdjacentJsDoc(state.comments, line)) {
    state.violations.push({
      file: state.rel,
      line,
      message: `missing JSDoc on ${kind} "${name}"`,
    });
  }
}

// A `/** ... */` block comment whose end line is directly above `line`.
function hasAdjacentJsDoc(comments, line) {
  return comments.some(
    (c) => c.type === 'CommentBlock' && c.value.startsWith('*') && c.loc.end.line === line - 1,
  );
}

/**
 * One-line summary: `N/M public declarations missing JSDoc` on violations,
 * `M public declarations documented` otherwise.
 */
export function publicDocsSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} public declarations documented`
    : `${violations}/${checked} public declarations missing JSDoc`;
}

/**
 * Parse `public-docs` arguments into `{ exclude, paths }`.
 *
 * @param {string[]} argv
 */
export function parsePublicDocsArgs(argv) {
  const opts = { exclude: [], paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, GATE_FLAGS);
  }
  return opts;
}

/**
 * The `public-docs` command body. Returns exit code 2 iff violations exist.
 */
export function runPublicDocs(argv, ctx) {
  const opts = parsePublicDocsArgs(argv);
  return runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    (files, root) => publicDocsViolations(files, root, opts),
    publicDocsSummary,
    'public-docs',
  );
}
