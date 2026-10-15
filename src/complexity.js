// Cyclomatic + cognitive complexity and method extraction for
// JavaScript/JSX/Flow/TS source.
//
// Uses @babel/parser (plugins routed by file extension — flow and typescript
// cannot be enabled together) to parse, then walks the AST to find every
// function-like entry (FunctionDeclaration, class ClassMethod, assigned
// FunctionExpression or ArrowFunctionExpression) and computes its complexity
// (cyclomatic by default, or cognitive — SonarSource v1.2 — via `metric`).
//
// Cyclomatic counting rules (base 1, +1 each): IfStatement, ForStatement,
// ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement,
// CatchClause, SwitchCase (including `default`), ConditionalExpression, and
// LogicalExpression (`&&`, `||`).
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
// Exported: the duplicates gate's Type-2 normalizer walks AST subtrees with
// the same exclusions when collecting function-local scopes.
export const SKIP_KEYS = new Set([
  'type', 'loc', 'range', 'sourceType', 'start', 'end',
  'leadingComments', 'trailingComments', 'innerComments', 'extra', 'directives',
]);

// Shared by both plugin routes; only the type-syntax plugin differs because
// @babel/parser refuses to combine flow and typescript. decorators-legacy
// plus decoratorAutoAccessors cover stage-3 decorator syntax (`accessor`
// fields included).
const COMMON_PLUGINS = [
  'jsx', 'decorators-legacy', 'decoratorAutoAccessors', 'classProperties',
  'classPrivateProperties', 'classPrivateMethods', 'objectRestSpread',
  'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport',
  'exportDefaultFrom', 'asyncGenerators', 'topLevelAwait',
];
const FLOW_PLUGINS = [...COMMON_PLUGINS, 'flow'];
const TS_PLUGINS = [...COMMON_PLUGINS, 'typescript'];
const TS_EXTS = new Set(['.ts', '.tsx']);

/**
 * Parse source and return every method/function entry with its complexity.
 *
 * @param {string} source  JavaScript/JSX/Flow/TypeScript source code.
 * @param {{ ext?: string, metric?: string }} [opts]  File extension used to
 *   route the flow-vs-typescript plugin (`.ts`/`.tsx` → typescript, else
 *   flow); `metric` selects `cyclomatic` (default) or `cognitive` scoring.
 * @returns {Array<{name: string, startLine: number, endLine: number, complexity: number}>}
 */
export function extractMethods(source, { ext, metric } = {}) {
  // Strip the AST node reference — external callers only need the summary.
  return parseMethods(source, ext, metric).map(({ node, ...m }) => m);
}

/**
 * Same walk as extractMethods, but each entry also keeps a reference to the
 * function AST node. Used by the `profile` command's instrumenter to wrap
 * the exact bodies the analyzer reports.
 *
 * @param {string} source
 * @param {{ ext?: string }} [opts]
 * @returns {Array<{name: string, startLine: number, endLine: number, complexity: number, node: object}>}
 */
export function extractMethodsWithNodes(source, { ext } = {}) {
  return parseMethods(source, ext);
}

function parseMethods(source, ext, metric) {
  const ast = parseSource(source, ext);
  const methods = [];
  // @babel/parser wraps the Program in a File node; the walker starts at Program.
  walkForEntries(ast.program, null, methods);
  const complexityOf = metric === 'cognitive' ? computeCognitive : computeComplexity;
  for (const m of methods) m.complexity = complexityOf(m.node.body);
  return methods;
}

function parseWith(source, ext, tokens) {
  const plugins = TS_EXTS.has(ext) ? TS_PLUGINS : FLOW_PLUGINS;
  return parse(source, {
    sourceType: 'module',
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins,
    tokens,
  });
}

/**
 * Parse source with the port's standard plugin routing. Shared by the
 * gate-check subcommands so every check sees the same AST.
 *
 * @param {string} source
 * @param {string} [ext]  File extension routing flow vs typescript plugins.
 */
export function parseSource(source, ext) {
  return parseWith(source, ext, false);
}

/**
 * Parse source with the port's standard plugin routing, keeping the whole
 * token stream plus the Program AST. Shared by tokenizeSource and the
 * duplicates gate's Type-2 normalization pass, which reads function-local
 * scopes out of the AST while masking the token lexemes.
 *
 * @param {string} source
 * @param {string} [ext]  File extension routing flow vs typescript plugins.
 * @returns {{tokens: object[], program: object}}
 */
export function parseTokenized(source, ext) {
  const ast = parseWith(source, ext, true);
  return { tokens: ast.tokens, program: ast.program };
}

// @babel/parser emits comments inside the token stream (tokens: true) as
// bare strings (`CommentLine`/`CommentBlock`), while real tokens carry a
// type object — skipped like upstream skips its CommentToken nodes.
function isCommentToken(t) {
  return typeof t.type === 'string';
}
/**
 * Tokenize source with the port's standard plugin routing: every token's
 * raw lexeme plus its start line, comments and the EOF sentinel skipped.
 * Shared by the duplicates gate, which scans lexeme windows.
 *
 * @param {string} source
 * @param {string} [ext]  File extension routing flow vs typescript plugins.
 * @returns {Array<{value: string, line: number}>}
 */
export function tokenizeSource(source, ext) {
  const { tokens } = parseTokenized(source, ext);
  return tokens
    .filter((t) => t.type.label !== 'eof' && !isCommentToken(t))
    .map((t) => ({ value: source.slice(t.start, t.end), line: t.loc.start.line }));
}

// Sentinel: a handler returns this when it has already descended into the
// node's children itself and the generic child traversal should be skipped.
const SKIP = Symbol('skip');

// Named constants for literals repeated across the module (magic_constants).
const ANON = '<anonymous>';
const IDENT = 'Identifier';

// One handler per AST node type that yields a method entry or controls how
// its children are traversed. Each handler is small (CC ≤ 4); walkForEntries
// is just the dispatch.
const HANDLERS = {
  FunctionDeclaration(node, className, methods) {
    if (!node.body) return;
    methods.push(makeMethod(node.id?.name ?? ANON, node));
  },
  // @babel/parser names class methods ClassMethod/ClassPrivateMethod (acorn
  // called them MethodDefinition). The method node itself carries body/params,
  // so makeMethod reads loc/complexity off it directly.
  ClassMethod: classMethodHandler,
  ClassPrivateMethod: classMethodHandler,
  VariableDeclarator(node, className, methods) {
    if (!node.init?.body || !FUNCTION_LIKE.has(node.init.type)) return;
    methods.push(makeMethod(node.id?.name ?? ANON, node.init));
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

export function isNode(v) {
  return v && typeof v === 'object' && v.type;
}

function makeMethod(name, fnNode) {
  return {
    name,
    startLine: fnNode.loc.start.line,
    endLine: fnNode.loc.end.line,
    node: fnNode,
  };
}

export function computeComplexity(root) {
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

// ---------- Cognitive complexity (SonarSource v1.2) ----------
//
// Unlike cyclomatic complexity the score starts at 0 and tracks how hard a
// method is to read: +1 per break in the linear flow (if/else-if/else, every
// loop kind, catch, each switch case including `default`, the conditional
// expression, each SEQUENCE of identical `&&`/`||` — `a && b && c` is one
// sequence, `a && b || c` is two) plus a nesting increment of +1 per
// enclosing structural level for every structural construct. `&&`/`||` never
// deepen. `else if` chains are flat — each chained if increments at its
// originating if's depth — while an if inside an else BLOCK still pays
// nesting. Lambda (function/arrow expression) bodies deepen one level but
// the lambda itself never increments; nested named FunctionDeclarations are
// skipped as their own entries.

const COGNITIVE_TYPES = COMPLEXITY_TYPES;

/**
 * Cognitive complexity of a function body.
 *
 * @param {object} body  the function's body node.
 * @param {{ countLambdas?: boolean }} [opts]  when false, lambda bodies are
 *   not traversed, so their branches do not count towards the enclosing
 *   method. Default: true.
 * @returns {number}
 */
export function computeCognitive(body, { countLambdas = true } = {}) {
  const s = { score: 0 };
  const visit = (n, depth, seqOp) => {
    if (!isNode(n) || isNamedFunctionDecl(n)) return;
    if (lambdaBody(n, depth, countLambdas, visit, s)) return;
    cognitiveStep(s, n, depth, seqOp, visit);
  };
  visit(body, 0, undefined);
  return s.score;
}

// Lambdas deepen without incrementing; `countLambdas: false` skips them.
// Returns true when the node was a lambda (caller stops the generic step).
function lambdaBody(n, depth, countLambdas, visit) {
  if (!FUNCTION_LIKE.has(n.type)) return false;
  if (countLambdas) {
    for (const c of childrenOf(n)) visit(c, depth + 1, undefined);
  }
  return true;
}

// One flow-break increment per structural node (basic + nesting), one per
// `&&`/`||` sequence root; then descend.
function cognitiveStep(s, n, depth, seqOp, visit) {
  if (COGNITIVE_TYPES.has(n.type)) {
    structuralStep(s, n, depth, visit);
    return;
  }
  if (isLogicalSeqRoot(n, seqOp)) s.score++;
  const childOp = n.type === 'LogicalExpression' ? n.operator : undefined;
  for (const c of childrenOf(n)) visit(c, depth, childOp);
}

// Structural constructs pay basic + nesting and deepen their subtree;
// IfStatement gets its own dispatch (flat else-if chains, else increments).
function structuralStep(s, n, depth, visit) {
  s.score += 1 + depth;
  if (n.type === 'IfStatement') {
    visitIf(s, n, depth, visit);
    return;
  }
  for (const c of childrenOf(n)) visit(c, depth + 1, undefined);
}

// IfStatement: then and bare `else` each pay the basic-plus-nesting
// increment and deepen one level. An `else if` chain is flat: the chained
// if is visited at its originating if's depth — it increments (when its own
// turn comes) but does not nest.
function visitIf(s, n, depth, visit) {
  visit(n.test, depth + 1, undefined);
  visit(n.consequent, depth + 1, undefined);
  const alt = n.alternate;
  if (!alt) return;
  if (alt.type === 'IfStatement') {
    visit(alt, depth, undefined);
    return;
  }
  s.score += 1 + depth;
  visit(alt, depth + 1, undefined);
}

// Only the ROOT of a same-operator `&&`/`||` sequence increments: the
// operator of an enclosing logical expression is passed down as `seqOp`.
function isLogicalSeqRoot(n, seqOp) {
  return (
    n.type === 'LogicalExpression' && LOGICAL_OPS.has(n.operator) && seqOp !== n.operator
  );
}

export function childrenOf(n) {
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
  if (!key) return ANON;
  if (key.type === IDENT) return key.name;
  // @babel/parser private-method key is PrivateName ({ id: { name } }).
  if (key.type === 'PrivateName') return '#' + key.id?.name;
  if (key.type === 'Literal') return String(key.value);
  return ANON;
}

export function leftName(node) {
  if (!node) return ANON;
  if (node.type === IDENT) return node.name;
  if (node.type === 'MemberExpression') {
    const obj = leftName(node.object);
    const prop =
      node.property.type === IDENT && !node.computed
        ? node.property.name
        : node.property.type === 'Literal'
        ? String(node.property.value)
        : '<anon>';
    return `${obj}.${prop}`;
  }
  return ANON;
}
