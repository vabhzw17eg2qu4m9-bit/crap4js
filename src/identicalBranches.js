// `identical-branches` subcommand: flags the copy-paste-edit bug family —
// syntactically identical pieces inside one construct where a second,
// slightly different piece was intended. Port of crap4dart's
// identical_branches gate (c6b2425add) with the JS host map:
//
// 1. Duplicate conditions in one if/else-if chain — every later branch is
//    unreachable.
// 2. Duplicate branch bodies in one chain (an `else` equal to its `then`;
//    a single-statement block equals the naked statement; the violation
//    points at the unwrapped statement's line).
// 3. Duplicate operands in one `&&`/`||` chain (`a || a` collapses to a)
//    and absorbed operands (`a || b && a` collapses to `a`); only the
//    outermost link of a same-operator chain reports.
// 4. Identical ternary branches (`c ? x : x`) — the condition is dead.
// 5. Duplicate positional arguments in one call (`f(w, h, w)`).
//    All-literal argument lists are exempt (uniform-value APIs like
//    `rect(8, 8, 8, 4)` stay quiet) and a literal is never reported as
//    the repeat. JS has no named/keyword arguments, so upstream's
//    named-argument exemption has no analog — an options object is one
//    positional value like any other; a spread element occupies no fixed
//    slot and is exempt.
// 6. Duplicate handler bodies in one try. JS's try admits exactly ONE
//    catch clause, so upstream's duplicate-catch-bodies check maps to the
//    only remaining same-construct handler pair: catch body vs finally
//    body — identical failure and unconditional paths double-execute the
//    same code (a copy-paste where the two were meant to differ).
//
// All comparisons use a canonical form: whitespace-, comment- and
// parenthesis-independent (babel drops parens and comments; the
// serializer walks the AST structurally and literals compare by value),
// operands of commutative operators sorted (`==`, `!=`, `===`, `!==`,
// `&&`, `||`, `+`, `*`, `&`, `|`, `^` — `a == b` matches `b == a`),
// same-operator nests of the associative operators flattened (`&&`, `||`,
// `+`, `*`, `&`, `|`, `^` — `a && b && c` compares equal regardless of
// grouping). Non-commutative operators (`<`, `>`, `<=`, `>=`, `-`, `/`,
// `??`, ...) keep their operand order and shape: `a < b` and `b < a` stay
// distinct. Only pieces of the SAME construct are compared; identical
// conditions in separate if statements are legal (the state may change
// between them). `switch` is excluded — duplicate cases are a syntax
// error in strict mode and no port of upstream's analyzer check.
//
// Upstream's config surface maps to the port's conventions exactly like
// string-hazards: default-on subcommand, warning severity (findings print
// but exit 0; `--severity error` exits 2 — reordering is
// equivalence-safe only for side-effect-free operands), ignore markers
// honored (`identical-branches` is in IGNORABLE_GATES).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import {
  ANON,
  CALL,
  IDENT,
  MEMBER,
  NEW_EXPRESSION,
  SKIP_KEYS,
  childrenOf,
  isNode,
  parseSource,
} from './complexity.js';

const GATE_ID = 'identical-branches';
const WARNING = 'warning';
const ERROR = 'error';
const SEVERITIES = new Set([WARNING, ERROR]);
const SEVERITY_FLAG = { '--severity': 'severity' };

const IF = 'IfStatement';
const CONDITIONAL = 'ConditionalExpression';
const LOGICAL = 'LogicalExpression';
const TRY_STATEMENT = 'TryStatement';
const BLOCK = 'BlockStatement';
const SPREAD = 'SpreadElement';
const BINARY_TYPES = new Set(['BinaryExpression', 'LogicalExpression']);
const AND = '&&';
const OR = '||';
const LITERALS = new Set([
  'NullLiteral',
  'BooleanLiteral',
  'StringLiteral',
  'NumericLiteral',
  'BigIntLiteral',
]);

// Upstream's two operator sets, extended with JS's strict-equality
// spellings: commutative operands are sorted, same-operator nests of the
// associative operators are flattened. `??` is in neither set.
const COMMUTATIVE_OPS = new Set([
  '==', '!=', '===', '!==', AND, OR, '+', '*', '&', '|', '^',
]);
const FLATTENABLE_OPS = new Set([AND, OR, '+', '*', '&', '|', '^']);

/**
 * Identical-branch violations across files. `checked` counts the scanned
 * constructs (chains, boolean chains, ternaries, multi-arg calls, tries).
 *
 * @param {string[]} files  absolute source-file paths.
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function identicalBranchesViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, UTF8);
    const state = {
      file: toRelPath(file, projectRoot),
      source,
      violations,
      constructs: 0,
    };
    scanProgram(parseSource(source, path.extname(file)).program, state);
    checked += state.constructs;
  }
  return { violations, checked };
}

// One generic AST walk with explicit parents (babel has no parent links):
// a chain link's parent is the enclosing if's `alternate`, a boolean chain
// link's parent is a same-operator logical expression — everything else is
// a construct root.
function scanProgram(program, state) {
  const visit = (node, parent) => {
    record(node, parent, state);
    for (const kid of childrenOf(node)) visit(kid, node);
  };
  visit(program, null);
}

const RECORD_HANDLERS = {
  [IF]: recordIf,
  [CONDITIONAL]: recordTernary,
  [LOGICAL]: recordLogical,
  [TRY_STATEMENT]: recordTry,
  [CALL]: checkCallArguments,
  [NEW_EXPRESSION]: checkCallArguments,
};

function record(node, parent, state) {
  const handler = RECORD_HANDLERS[node.type];
  if (handler) handler(node, parent, state);
}

function recordIf(node, parent, state) {
  if (parent?.type === IF && parent.alternate === node) return;
  state.constructs++;
  scanChain(node, state);
}

// Walks one if/else-if chain: `alternate` being another IfStatement is a
// chain link, anything else is the chain's final `else`. Conditions and
// bodies compare within this chain only.
function scanChain(head, state) {
  const conds = new Map();
  const bodies = new Map();
  let link = head;
  while (link.type === IF) {
    reportBody(bodies, unwrapBlock(link.consequent),
      'duplicate branch body in if/else-if chain', state);
    reportRepeat(conds, exprKey(link.test), lineOf(link.test),
      `duplicate condition in if/else-if chain: '${snippet(link.test, state)}'`,
      state);
    const alt = link.alternate;
    if (!alt) return;
    if (alt.type !== IF) {
      reportBody(bodies, unwrapBlock(alt),
        'duplicate branch body in if/else-if chain', state);
      return;
    }
    link = alt;
  }
}

// Handlers share the walker's (node, parent, state) shape; not every
// handler needs the parent link.
function recordTernary(node, _parent, state) {
  state.constructs++;
  if (exprKey(node.consequent) !== exprKey(node.alternate)) return;
  add(state, lineOf(node.consequent),
    `identical then/else branches of conditional expression: `
    + `'${snippet(node.consequent, state)}' — the condition is dead`);
}

function recordLogical(node, parent, state) {
  if (node.operator !== AND && node.operator !== OR) return;
  if (parent?.type === LOGICAL && parent.operator === node.operator) return;
  state.constructs++;
  checkBooleanChain(node, state);
}

function checkBooleanChain(node, state) {
  const operands = [];
  flattenOperands(node.operator, node.left, operands);
  flattenOperands(node.operator, node.right, operands);
  const seen = new Set();
  for (const operand of operands) {
    if (!seen.has(operand.key)) {
      seen.add(operand.key);
      continue;
    }
    add(state, lineOf(node),
      `duplicate operand in '${node.operator}' chain: `
      + `'${snippet(operand.node, state)}' repeats `
      + '— the chain collapses to the single operand');
    return;
  }
  checkAbsorption(node, state);
}

// Absorption law: an operand of the chain that is also a conjunct (for
// `||`) or disjunct (for `&&`) of a sibling operand makes the sibling's
// extra terms dead — `a || b && a` collapses to `a`. Same law both ways:
// `a && (b || a)` collapses to `a`.
function checkAbsorption(node, state) {
  const siblings = [];
  flattenOperands(node.operator, node, siblings);
  const standalone = new Set(siblings.map((sibling) => sibling.key));
  const nestedOp = node.operator === OR ? AND : OR;
  for (const sibling of siblings) {
    const conjuncts = [];
    flattenOperands(nestedOp, sibling.node, conjuncts);
    for (const conjunct of conjuncts) {
      if (conjunct.key === sibling.key || !standalone.has(conjunct.key)) {
        continue;
      }
      add(state, lineOf(conjunct.node),
        `operand of '${node.operator}' is implied by another operand `
        + `(absorption): '${snippet(conjunct.node, state)}' also appears `
        + 'standalone — the extra terms are dead');
      return;
    }
  }
}

// JS's try admits exactly one catch clause, so upstream's duplicate-catch
// check maps to the same construct's other handler: the finally body.
// The violation points at the finally body (the later occurrence in
// source order, like every repeat report here).
function recordTry(node, _parent, state) {
  state.constructs++;
  if (!node.handler || !node.finalizer) return;
  const catchBody = unwrapBlock(node.handler.body);
  const finallyBody = unwrapBlock(node.finalizer);
  if (structKey(catchBody) !== structKey(finallyBody)) return;
  add(state, lineOf(finallyBody),
    `duplicate catch body in try statement: '${snippet(finallyBody, state)}' `
    + `(same as line ${lineOf(catchBody)})`);
}

// Positional slots only: JS has no named arguments (upstream's
// named-argument exemption has no analog), spreads occupy no fixed slot,
// all-literal lists are uniform-value APIs, and a literal is never the
// reported repeat.
function checkCallArguments(node, _parent, state) {
  if (node.arguments.length < 2) return;
  state.constructs++;
  const positional = node.arguments.filter((arg) => arg.type !== SPREAD);
  if (positional.length < 2 || positional.every(isLiteral)) return;
  const seen = new Map();
  positional.forEach((arg, i) => {
    if (isLiteral(arg)) return;
    const key = exprKey(arg);
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, i);
      return;
    }
    add(state, lineOf(arg),
      `duplicate argument in call to ${calleeLabel(node.callee)}: `
      + `'${snippet(arg, state)}' (same as argument ${first + 1})`);
  });
}

function calleeLabel(callee) {
  if (callee.type === IDENT) return `'${callee.name}'`;
  if (callee.type === MEMBER && !callee.computed
    && callee.property.type === IDENT) {
    return `'${callee.property.name}'`;
  }
  return `'${ANON}'`;
}

function isLiteral(node) {
  return LITERALS.has(node.type);
}

function reportBody(seen, stmt, prefix, state) {
  reportRepeat(seen, structKey(stmt), lineOf(stmt),
    `${prefix}: '${snippet(stmt, state)}'`, state);
}

function reportRepeat(seen, key, line, message, state) {
  const first = seen.get(key);
  if (first === undefined) {
    seen.set(key, line);
    return;
  }
  add(state, line, `${message} (same as line ${first})`);
}

function add(state, line, message) {
  state.violations.push({ file: state.file, line, message });
}

// A single-statement block unwraps to its statement, so `{ return 1; }`
// equals `return 1;` and the violation points at the code, not the brace.
function unwrapBlock(node) {
  while (node.type === BLOCK && node.body.length === 1) node = node.body[0];
  return node;
}

function lineOf(node) {
  return node.loc.start.line;
}

// Source text, truncated for messages.
function snippet(node, state) {
  const text = state.source.slice(node.start, node.end);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

// ---------- Canonical form ----------

// The canonical key of an expression: binary/logical nodes render as
// `op(operand,...)` — same-operator nests of the flattenable operators
// flatten, commutative operands sort (the two sets differ: `==` sorts
// without flattening, `-` does neither), everything else keeps its tree
// shape; non-binary nodes fall through to the structural key.
function exprKey(node) {
  if (!BINARY_TYPES.has(node.type)) return structKey(node);
  const op = node.operator;
  const operands = [];
  if (FLATTENABLE_OPS.has(op)) {
    flattenOperands(op, node.left, operands);
    flattenOperands(op, node.right, operands);
  } else {
    operands.push(
      { key: exprKey(node.left) },
      { key: exprKey(node.right) },
    );
  }
  if (COMMUTATIVE_OPS.has(op)) operands.sort((a, b) => (a.key > b.key ? 1 : -1));
  return `${op}(${operands.map((o) => o.key).join(',')})`;
}

// Collects the canonical `{key, node}` operands of an `op` chain.
// Same-operator nests flatten so `a && b && c` compares equal regardless
// of grouping; other operators keep their tree shape because flattening
// would merge semantically different expressions (`a - (b - c)`).
function flattenOperands(op, node, out) {
  if (BINARY_TYPES.has(node.type) && node.operator === op) {
    flattenOperands(op, node.left, out);
    flattenOperands(op, node.right, out);
    return;
  }
  out.push({ key: exprKey(node), node });
}

// The structural key of any node: a deterministic type+property walk.
// babel drops parentheses and keeps comments out of the tree, so the key
// is whitespace-, comment- and parenthesis-independent; leaf values
// (names, literal values, regex patterns) compare by value.
function structKey(node) {
  if (!isNode(node)) return JSON.stringify(node);
  const parts = [node.type];
  for (const key of Object.keys(node)) {
    const rendered = structValue(key, node[key]);
    if (rendered) parts.push(rendered);
  }
  return `(${parts.join(';')})`;
}

// One property's canonical rendering, or null when it carries no key
// weight (skipped keys, null values, empty arrays).
function structValue(key, value) {
  if (SKIP_KEYS.has(key) || value == null) return null;
  if (Array.isArray(value)) {
    return value.length > 0 ? `${key}[${value.map(structKey).join(',')}]` : null;
  }
  if (isNode(value)) return `${key}(${structKey(value)})`;
  return `${key}=${JSON.stringify(value)}`;
}

/**
 * One-line summary: `M constructs checked, no identical-branch findings`,
 * or `N identical-branch finding(s) (M constructs checked)`.
 */
export function identicalBranchesSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} constructs checked, no identical-branch findings`
    : `${violations} identical-branch finding(s) (${checked} constructs checked)`;
}

/**
 * The `identical-branches` command body: `--severity error` makes
 * violations fail (exit 2); the default warning severity reports and
 * exits 0. Unknown flags and unknown severity values are usage errors
 * (exit 1).
 */
export function runIdenticalBranches(argv, ctx) {
  const opts = { severity: WARNING, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, SEVERITY_FLAG);
  }
  if (!SEVERITIES.has(opts.severity)) {
    throw new Error(`--severity must be ${WARNING} or ${ERROR}: ${opts.severity}`);
  }
  const code = runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    identicalBranchesViolations,
    identicalBranchesSummary,
    GATE_ID,
  );
  return opts.severity === ERROR ? code : 0;
}
