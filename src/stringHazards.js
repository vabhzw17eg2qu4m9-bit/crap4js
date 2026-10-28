// `string-hazards` subcommand: flags string literals whose escaping or
// pattern usage contradicts what the author almost certainly meant.
// Port of crap4dart's string_hazards gate (62fec6833e) with the JS string
// map — three near-zero-FP checks, all from the parsed AST:
//
// 1. Escaped interpolation — `\${name}` / `\$name` inside a template
//    literal renders the literal text `$name`. Flagged only when the same
//    root identifier is genuinely interpolated (`${name}`) elsewhere in
//    the same file (sibling evidence), keeping deliberate shell escapes
//    quiet. Plain '...' strings never interpolate in JS, so they are not
//    scanned (upstream scans Dart's non-raw strings, which do); tagged
//    templates (String.raw and friends) are out of scope, like upstream's
//    raw strings.
// 2. RegExp source with an escaped anchor — a regex literal `/...\$/` or
//    the first string argument of `RegExp(...)` / `new RegExp(...)`
//    ending with `\$` (or starting with `\^`) matches a literal
//    dollar/caret where the end/start anchor was almost certainly
//    intended (a plain `$`/`^` is the anchor). The check reads the regex
//    SOURCE: for string arguments that is the decoded value (`'...\\$'`
//    survives as `\$`), for literals babel's pattern text.
// 3. Anchors in literal String patterns — String.prototype.replace /
//    replaceAll / split treat a string search value as literal text, so a
//    leading `^` or a trailing `$` written unescaped can only ever match
//    that literal character — a RegExp was probably intended. Upstream's
//    raw trailing-`$` rule maps to the source form: `'abc\$'` (escaped in
//    source — dollar awareness) is spared, `'abc$'` is flagged. Dart's
//    adjacent-strings part scan has no JS analog (no literal
//    juxtaposition; `'a' + 'b$'` arguments are non-literal and skipped),
//    matching the magic-constants precedent.
//
// Upstream's config surface (enabled/severity/ignorable) maps to the
// port's conventions: default-on subcommand, violations honor ignore
// markers (registered in IGNORABLE_GATES as `string-hazards`), and
// warning severity — findings are printed but exit 0 by default;
// `--severity error` exits 2.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import {
  CALL,
  IDENT,
  MEMBER,
  NEW_EXPRESSION,
  REGEX_LITERAL,
  STRING_LITERAL,
  TAGGED_TEMPLATE,
  TEMPLATE_LITERAL,
  childrenOf,
  parseSource,
} from './complexity.js';

const GATE_ID = 'string-hazards';
const WARNING = 'warning';
const ERROR = 'error';
const SEVERITIES = new Set([WARNING, ERROR]);
const SEVERITY_FLAG = { '--severity': 'severity' };

// String.prototype methods whose string search value is matched
// literally — the JS map of upstream's replaceFirst/replaceAll/split
// family (the *Mapped variants have no JS analog).
const ANCHOR_METHODS = new Set(['replace', 'replaceAll', 'split']);

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * String-hazard violations across files.
 *
 * @param {string[]} files  absolute source-file paths.
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function stringHazardsViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const ast = parseSource(readFileSync(file, UTF8), path.extname(file));
    checked++;
    violations.push(...hazardsIn(ast.program, toRelPath(file, projectRoot)));
  }
  return { violations, checked };
}

function hazardsIn(program, file) {
  const state = { file, violations: [], escaped: [], evidence: new Set() };
  visitNode(program, state);
  resolveEscaped(state);
  return state.violations;
}

// One generic AST walk; tagged templates are visited except their quasi —
// raw-text templates are out of scope, like upstream's raw strings.
function visitNode(node, state) {
  record(node, state);
  for (const kid of children(node)) visitNode(kid, state);
}

function children(node) {
  const kids = childrenOf(node);
  return node.type === TAGGED_TEMPLATE ? kids.filter((k) => k !== node.quasi) : kids;
}

function record(node, state) {
  if (node.type === TEMPLATE_LITERAL) scanTemplate(node, state);
  else if (node.type === REGEX_LITERAL) checkRawAnchor(node.pattern, lineOf(node), state);
  else recordCall(node, state);
}

// Shapes 2+3 call sites: `RegExp(...)` / `new RegExp(...)` take the
// escaped-anchor check on their first string argument; the literal-pattern
// methods take the anchor check on their receiver call.
function recordCall(node, state) {
  if (!isCallLike(node)) return;
  if (isRegExpCallee(node.callee)) checkRegExpArg(node.arguments[0], state);
  else if (isAnchorMethod(node.callee)) checkLiteralPattern(node.arguments[0], state);
}

function isCallLike(node) {
  return node.type === CALL || node.type === NEW_EXPRESSION;
}

function isRegExpCallee(callee) {
  return callee.type === IDENT && callee.name === 'RegExp';
}

// A literal-pattern method needs a receiver (`s.split(...)`); a bare
// `split(...)` function call is out of scope (upstream: target == null).
function isAnchorMethod(callee) {
  return callee.type === MEMBER && !callee.computed
    && callee.property.type === IDENT && ANCHOR_METHODS.has(callee.property.name);
}

function checkRegExpArg(arg, state) {
  if (arg && arg.type === STRING_LITERAL) checkRawAnchor(arg.value, lineOf(arg), state);
}

// Shape 2: an escaped anchor in the regex SOURCE matches the literal
// character where the end/start anchor was almost certainly intended.
function checkRawAnchor(source, line, state) {
  if (source.endsWith('\\$')) {
    add(state, line, `RegExp source ends with '\\$' — that is a literal '$' character, not the end anchor; did you mean '$'?`);
  } else if (source.startsWith('\\^')) {
    add(state, line, `RegExp source starts with '\\^' — that is a literal '^' character, not the start anchor; did you mean '^'?`);
  }
}

// Shape 3: anchors inside a literal string search value can only ever
// match that literal character.
function checkLiteralPattern(arg, state) {
  if (!arg || arg.type !== STRING_LITERAL) return; // variables, regex, concat — skipped
  if (arg.value.startsWith('^')) {
    add(state, lineOf(arg), `literal pattern starts with '^' — String patterns match literally, so this can only match a literal '^' character; a RegExp was probably intended`);
  }
  if (endsWithUnescapedDollar(arg)) {
    add(state, lineOf(arg), `literal pattern ends with '$' — String patterns match literally, so this can only match a literal '$' character; a RegExp was probably intended`);
  }
}

// Upstream spares Dart's escaped trailing `\$` (dollar awareness in the
// source); JS values can't tell, so the raw source form decides:
// `'abc\$'` is spared, `'abc$'` flagged.
function endsWithUnescapedDollar(arg) {
  if (!arg.value.endsWith('$')) return false;
  const raw = arg.extra?.raw;
  return !(raw && raw.slice(0, -1).endsWith('\\$'));
}

// Shape 1: quasis carry the literal text (the raw form keeps the `\$`),
// and every interpolated expression contributes sibling evidence by its
// root identifier.
function scanTemplate(node, state) {
  for (const quasi of node.quasis) scanEscapedDollars(quasi.value.raw, lineOf(quasi), state);
  for (const expr of node.expressions) {
    const root = rootName(expr);
    if (root) state.evidence.add(root);
  }
}

// Walks the text pairing escapes (`\\` consumes two chars, so `\\$` never
// reads as an escaped dollar) and records `\$ident` / `\${ident}` spots.
function scanEscapedDollars(text, line, state) {
  let i = 0;
  while (i < text.length - 1) {
    i = text[i] === '\\' ? escapedAt(text, i, line, state) : i + 1;
  }
}

function escapedAt(text, i, line, state) {
  if (text[i + 1] === '$') {
    const name = identifierAfter(text, i + 2);
    if (name) state.escaped.push({ name, line });
  }
  return i + 2;
}

// The identifier (or brace-enclosed identifier) after `\$`, or null.
function identifierAfter(text, i) {
  const start = text[i] === '{' ? i + 1 : i;
  const end = identEnd(text, start);
  return end > start ? text.slice(start, end) : null;
}

function identEnd(text, start) {
  if (!IDENT_START.test(text[start] ?? '')) return start;
  let end = start + 1;
  while (end < text.length && IDENT_CHAR.test(text[end])) end += 1;
  return end;
}

// Emits escaped-interpolation violations that have sibling evidence, one
// per (line, identifier) pair.
function resolveEscaped(state) {
  const seen = new Set();
  for (const { name, line } of state.escaped) {
    if (!state.evidence.has(name)) continue;
    const key = `${line}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add(state, line, `escaped interpolation '\\$${name}' renders literal '$${name}'; '$${name}' is interpolated elsewhere in this file — stray backslash?`);
  }
}

// The root identifier of an interpolated expression: `user.name` and
// `builder.build()` expose their receiver root; index expressions and
// bare calls expose nothing (upstream's root-name walk).
function rootName(expr) {
  let node = expr;
  for (let next = unwrapMember(node); next; next = unwrapMember(node)) node = next;
  return node.type === IDENT ? node.name : null;
}

function unwrapMember(node) {
  if (node.type === MEMBER) return node.computed ? null : node.object;
  if (node.type === CALL) return memberTarget(node.callee);
  return null;
}

function memberTarget(callee) {
  return callee.type === MEMBER && !callee.computed ? callee.object : null;
}

function add(state, line, message) {
  state.violations.push({ file: state.file, line, message });
}

function lineOf(node) {
  return node.loc.start.line;
}

/**
 * One-line summary: `M files free of string hazards`, or `N string
 * hazard(s) in M files`.
 */
export function stringHazardsSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} files free of string hazards`
    : `${violations} string hazard(s) in ${checked} files`;
}

/**
 * The `string-hazards` command body: `--severity error` makes violations
 * fail (exit 2); the default warning severity reports and exits 0.
 * Unknown flags and unknown severity values are usage errors (exit 1).
 */
export function runStringHazards(argv, ctx) {
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
    stringHazardsViolations,
    stringHazardsSummary,
    GATE_ID,
  );
  return opts.severity === ERROR ? code : 0;
}
