// Import-specifier extraction and relative-specifier resolution, shared by
// the unused-files and banned-imports subcommands.

import { statSync } from 'node:fs';
import path from 'node:path';
import { childrenOf, isNode } from './complexity.js';
import { toRelPath } from './files.js';

// Extensions tried when resolving an extensionless relative specifier.
const SOURCE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];

/**
 * All import/require specifiers of a parsed program: static imports,
 * re-exports (`export ... from`), dynamic `import('...')`, and
 * `require('...')`.
 *
 * @param {object} program  parsed Program node.
 * @returns {string[]} specifier strings.
 */
export function collectImports(program) {
  const specs = [];
  const visit = (n) => {
    if (!isNode(n)) return;
    const spec = importSpecifierOf(n);
    if (spec !== null) specs.push(spec);
    for (const c of childrenOf(n)) visit(c);
  };
  visit(program);
  return specs;
}

// Static import/export forms: the specifier lives in node.source.
const SOURCE_FORMS = new Set([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
]);

// The specifier a node carries, or null when the node is not an import.
function importSpecifierOf(n) {
  // Babel 8 parses dynamic import() as ImportExpression; older parsers
  // produce a CallExpression with an Import/require callee.
  if (n.type === 'ImportExpression') return literalValue(n.source);
  if (n.type === 'CallExpression') return literalArg(n);
  if (SOURCE_FORMS.has(n.type)) return n.source?.value ?? null;
  return null;
}

function isRequireLike(callee) {
  return callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require');
}

function literalArg(call) {
  return isRequireLike(call.callee) ? literalValue(call.arguments[0]) : null;
}

function literalValue(node) {
  return node?.type === 'StringLiteral' ? node.value : null;
}

/**
 * Resolve an import specifier to a project-relative path. Relative
 * specifiers resolve against the importing file's directory, trying the
 * exact path, each source extension, and `/index.<ext>`. Bare specifiers
 * (packages, URLs) are external and return null.
 *
 * @param {string} specifier
 * @param {string} importerFile  absolute path of the importing file.
 * @param {string} projectRoot
 * @returns {string|null} project-relative POSIX path, or null.
 */
export function resolveImport(specifier, importerFile, projectRoot) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importerFile), specifier);
  const candidates = [base, ...withExts(base), ...withExts(path.join(base, 'index'))];
  const hit = candidates.find(isFile);
  return hit ? toRelPath(hit, projectRoot) : null;
}

function withExts(p) {
  return SOURCE_EXTS.map((e) => p + e);
}

// The exact-path candidate may hit a directory (e.g. `./lib`); only a
// real file resolves.
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
