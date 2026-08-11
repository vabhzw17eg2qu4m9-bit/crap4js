// Cyclomatic complexity + method extraction for JavaScript source.
//
// Uses acorn to parse, then walks the AST to find every function-like entry
// (FunctionDeclaration, class MethodDefinition, assigned FunctionExpression
// or ArrowFunctionExpression) and computes its cyclomatic complexity.
//
// Counting rules (base 1, +1 each): IfStatement, ForStatement, ForInStatement,
// ForOfStatement, WhileStatement, DoWhileStatement, CatchClause, SwitchCase
// (including `default`), ConditionalExpression, and LogicalExpression (`&&`,
// `||`).
//
// Lambda/arrow bodies count TOWARDS the enclosing function (we descend into
// them when computing the parent's complexity). Nested NAMED
// FunctionDeclarations are skipped — they are reported as their own entries.

import { parse } from 'acorn';

const COMPLEXITY_TYPES = new Set([
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'CatchClause',
  'ConditionalExpression',
]);

const FUNCTION_LIKE = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

const SKIP_KEYS = new Set(['type', 'loc', 'start', 'end', 'range', 'sourceType']);

/**
 * Parse source and return every method/function entry with its complexity.
 *
 * @param {string} source  JavaScript source code.
 * @returns {Array<{name: string, startLine: number, endLine: number, complexity: number}>}
 */
export function extractMethods(source) {
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    locations: true,
  });
  const methods = [];
  walkForEntries(ast, null, methods);
  return methods;
}

function walkForEntries(node, className, methods) {
  if (!node || typeof node !== 'object' || !node.type) return;

  switch (node.type) {
    case 'FunctionDeclaration': {
      if (node.body) {
        const name = node.id ? node.id.name : '<anonymous>';
        methods.push(makeMethod(name, node));
      }
      break;
    }
    case 'MethodDefinition': {
      if (node.kind === 'constructor') break;
      if (node.value && node.value.body) {
        const mn = keyName(node.key);
        const name = className ? `${className}.${mn}` : mn;
        methods.push(makeMethod(name, node.value));
      }
      break;
    }
    case 'PropertyDefinition':
      // Class field initialisers are not methods; ignore.
      break;
    case 'VariableDeclarator': {
      if (node.init && FUNCTION_LIKE.has(node.init.type) && node.init.body) {
        const name = node.id && node.id.name ? node.id.name : '<anonymous>';
        methods.push(makeMethod(name, node.init));
      }
      break;
    }
    case 'AssignmentExpression': {
      if (node.right && FUNCTION_LIKE.has(node.right.type) && node.right.body) {
        methods.push(makeMethod(leftName(node.left), node.right));
      }
      break;
    }
    case 'Property': {
      // Object-literal method shorthand or `{ key: function () {} }`.
      if (node.value && FUNCTION_LIKE.has(node.value.type) && node.value.body) {
        methods.push(makeMethod(keyName(node.key), node.value));
      }
      break;
    }
    case 'ClassDeclaration':
    case 'ClassExpression': {
      const cn = node.id ? node.id.name : className;
      if (node.body && Array.isArray(node.body.body)) {
        for (const child of node.body.body) {
          walkForEntries(child, cn, methods);
        }
      }
      return;
    }
    case 'ExportDefaultDeclaration':
    case 'ExportNamedDeclaration': {
      // Walk the declaration inside; the export wrapper is transparent.
      if (node.declaration) walkForEntries(node.declaration, className, methods);
      return;
    }
  }

  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) {
        if (c && typeof c === 'object' && c.type) walkForEntries(c, className, methods);
      }
    } else if (v && typeof v === 'object' && v.type) {
      walkForEntries(v, className, methods);
    }
  }
}

function makeMethod(name, fnNode) {
  return {
    name,
    startLine: fnNode.loc.start.line,
    endLine: fnNode.loc.end.line,
    complexity: computeComplexity(fnNode.body),
  };
}

function computeComplexity(root) {
  let cc = 1;
  const walk = (n) => {
    if (!n || typeof n !== 'object' || !n.type) return;
    if (COMPLEXITY_TYPES.has(n.type)) cc++;
    if (n.type === 'SwitchCase') cc++;
    if (n.type === 'LogicalExpression' && (n.operator === '&&' || n.operator === '||')) cc++;
    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      const v = n[key];
      if (Array.isArray(v)) {
        for (const c of v) {
          if (c && typeof c === 'object' && c.type) {
            // Nested NAMED FunctionDeclaration is reported separately.
            if (c.type === 'FunctionDeclaration' && c.id) continue;
            walk(c);
          }
        }
      } else if (v && typeof v === 'object' && v.type) {
        if (v.type === 'FunctionDeclaration' && v.id) continue;
        walk(v);
      }
    }
  };
  walk(root);
  return cc;
}

function keyName(key) {
  if (!key) return '<anonymous>';
  if (key.type === 'Identifier' || key.type === 'PrivateIdentifier') {
    return key.type === 'PrivateIdentifier' ? '#' + key.name : key.name;
  }
  if (key.type === 'Literal') return String(key.value);
  return '<anonymous>';
}

function leftName(node) {
  if (!node) return '<anonymous>';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') {
    const obj = leftName(node.object);
    const prop =
      node.property.type === 'Identifier' && !node.computed
        ? node.property.name
        : node.property.type === 'Literal'
        ? String(node.property.value)
        : '<anon>';
    return `${obj}.${prop}`;
  }
  return '<anonymous>';
}
