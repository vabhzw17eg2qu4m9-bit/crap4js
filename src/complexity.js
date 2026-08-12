// Cyclomatic complexity + method extraction for JavaScript/JSX/Flow/TS source.
//
// Uses @babel/parser (plugins routed by file extension — flow and typescript
// cannot be enabled together) to parse, then walks the AST to find every
// function-like entry (FunctionDeclaration, class ClassMethod, assigned
// FunctionExpression or ArrowFunctionExpression) and computes its cyclomatic
// complexity.
//
// Counting rules (base 1, +1 each): IfStatement, ForStatement, ForInStatement,
// ForOfStatement, WhileStatement, DoWhileStatement, CatchClause, SwitchCase
// (including `default`), ConditionalExpression, and LogicalExpression (`&&`,
// `||`).
//
// Lambda/arrow bodies count TOWARDS the enclosing function (we descend into
// them when computing the parent's complexity). Nested NAMED
// FunctionDeclarations are skipped — they are reported as their own entries.

import { parse } from '@babel/parser';

const COMPLEXITY_TYPES = new Set([
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'CatchClause',
  'SwitchCase',
  'ConditionalExpression',
]);

const LOGICAL_OPS = new Set(['&&', '||']);

const FUNCTION_LIKE = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

// Babel attaches extra keys the generic traversal should not descend into
// (comment arrays, raw-source `extra`, `directives`, byte offsets). acorn's
// `range`/`sourceType` are kept for safety even though acorn is no longer used.
const SKIP_KEYS = new Set([
  'type', 'loc', 'range', 'sourceType', 'start', 'end',
  'leadingComments', 'trailingComments', 'innerComments', 'extra', 'directives',
]);

// Shared by both plugin routes; only the type-syntax plugin differs because
// @babel/parser refuses to combine flow and typescript.
const COMMON_PLUGINS = [
  'jsx', 'decorators-legacy', 'classProperties', 'classPrivateProperties',
  'classPrivateMethods', 'objectRestSpread', 'optionalChaining',
  'nullishCoalescingOperator', 'dynamicImport', 'exportDefaultFrom',
  'asyncGenerators', 'topLevelAwait',
];
const FLOW_PLUGINS = [...COMMON_PLUGINS, 'flow'];
const TS_PLUGINS = [...COMMON_PLUGINS, 'typescript'];
const TS_EXTS = new Set(['.ts', '.tsx']);

/**
 * Parse source and return every method/function entry with its complexity.
 *
 * @param {string} source  JavaScript/JSX/Flow/TypeScript source code.
 * @param {{ ext?: string }} [opts]  File extension used to route the
 *   flow-vs-typescript plugin (`.ts`/`.tsx` → typescript, else flow).
 * @returns {Array<{name: string, startLine: number, endLine: number, complexity: number}>}
 */
export function extractMethods(source, { ext } = {}) {
  const plugins = TS_EXTS.has(ext) ? TS_PLUGINS : FLOW_PLUGINS;
  const ast = parse(source, {
    sourceType: 'module',
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins,
  });
  const methods = [];
  // @babel/parser wraps the Program in a File node; the walker starts at Program.
  walkForEntries(ast.program, null, methods);
  return methods;
}

// Sentinel: a handler returns this when it has already descended into the
// node's children itself and the generic child traversal should be skipped.
const SKIP = Symbol('skip');

// One handler per AST node type that yields a method entry or controls how
// its children are traversed. Each handler is small (CC ≤ 4); walkForEntries
// is just the dispatch.
const HANDLERS = {
  FunctionDeclaration(node, className, methods) {
    if (!node.body) return;
    methods.push(makeMethod(node.id?.name ?? '<anonymous>', node));
  },
  // @babel/parser names class methods ClassMethod/ClassPrivateMethod (acorn
  // called them MethodDefinition). The method node itself carries body/params,
  // so makeMethod reads loc/complexity off it directly.
  ClassMethod: classMethodHandler,
  ClassPrivateMethod: classMethodHandler,
  VariableDeclarator(node, className, methods) {
    if (!node.init?.body || !FUNCTION_LIKE.has(node.init.type)) return;
    methods.push(makeMethod(node.id?.name ?? '<anonymous>', node.init));
  },
  AssignmentExpression(node, className, methods) {
    if (!node.right?.body || !FUNCTION_LIKE.has(node.right.type)) return;
    methods.push(makeMethod(leftName(node.left), node.right));
  },
  // Object-literal shorthand `{ m() {} }` → ObjectMethod (body inline).
  ObjectMethod(node, className, methods) {
    if (!node.body) return;
    methods.push(makeMethod(keyName(node.key), node));
  },
  // Object-literal keyed function `{ m: function () {} }` → ObjectProperty
  // whose value is the function (acorn called both shapes Property).
  ObjectProperty(node, className, methods) {
    if (!node.value?.body || !FUNCTION_LIKE.has(node.value.type)) return;
    methods.push(makeMethod(keyName(node.key), node.value));
  },
  ClassDeclaration: classHandler,
  ClassExpression: classHandler,
  ExportDefaultDeclaration(node, className, methods) {
    // Walk the declaration inside; the export wrapper is transparent.
    if (node.declaration) walkForEntries(node.declaration, className, methods);
    return SKIP;
  },
  ExportNamedDeclaration(node, className, methods) {
    if (node.declaration) walkForEntries(node.declaration, className, methods);
    return SKIP;
  },
};

function classHandler(node, className, methods) {
  // Class field initialisers (PropertyDefinition) are not methods; the body
  // is the only place method entries live, so we walk it directly with the
  // class's own name as context and skip the generic traversal.
  const cn = node.id?.name ?? className;
  for (const child of node.body?.body ?? []) walkForEntries(child, cn, methods);
  return SKIP;
}

// Shared by ClassMethod and ClassPrivateMethod: the node itself is the function
// (Babel), so loc/complexity come straight off it. Constructors are excluded.
function classMethodHandler(node, className, methods) {
  if (node.kind === 'constructor') return;
  if (!node.body) return;
  const mn = keyName(node.key);
  methods.push(makeMethod(className ? `${className}.${mn}` : mn, node));
}

function walkForEntries(node, className, methods) {
  if (!isNode(node)) return;
  const handler = HANDLERS[node.type];
  if (handler?.(node, className, methods) === SKIP) return;
  visitChildren(node, className, methods);
}

function visitChildren(node, className, methods) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) {
        if (isNode(c)) walkForEntries(c, className, methods);
      }
    } else if (isNode(v)) {
      walkForEntries(v, className, methods);
    }
  }
}

function isNode(v) {
  return v && typeof v === 'object' && v.type;
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
  const visit = (n) => {
    if (!isNode(n)) return;
    cc += complexityDelta(n);
    for (const child of childrenOf(n)) {
      // Nested NAMED FunctionDeclaration is reported as its own entry; skip
      // its body so its branches don't count toward the enclosing function.
      if (!isNamedFunctionDecl(child)) visit(child);
    }
  };
  visit(root);
  return cc;
}

function complexityDelta(n) {
  if (COMPLEXITY_TYPES.has(n.type)) return 1;
  if (n.type === 'LogicalExpression' && LOGICAL_OPS.has(n.operator)) return 1;
  return 0;
}

function childrenOf(n) {
  const out = [];
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = n[key];
    if (Array.isArray(v)) out.push(...v.filter(isNode));
    else if (isNode(v)) out.push(v);
  }
  return out;
}

function isNamedFunctionDecl(n) {
  return n.type === 'FunctionDeclaration' && n.id;
}

function keyName(key) {
  if (!key) return '<anonymous>';
  if (key.type === 'Identifier') return key.name;
  // @babel/parser private-method key is PrivateName ({ id: { name } }).
  if (key.type === 'PrivateName') return '#' + key.id?.name;
  if (key.type === 'Literal') return String(key.value);
  return '<anonymous>';
}

export function leftName(node) {
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
