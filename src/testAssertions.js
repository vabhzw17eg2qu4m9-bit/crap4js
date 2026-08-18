// `test-assertions` subcommand: flags node:test `test()`/`it()` bodies
// that contain fewer than min_assertions (default 1) assertion calls — a
// test without assertions compiles, runs green, and verifies nothing.
// Port of crap4dart's test_assertions gate (0.9.x) with the JS assertion
// map: calls through bindings imported from `node:assert`/`assert`
// (default, namespace, or named imports; `/strict` variants included —
// every export of the assert module is an assertion), plus `t.assert*`
// calls on the node:test context parameter.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { testFiles, toRelPath } from './files.js';
import { runCheck } from './gateCommon.js';
import { childrenOf, isNode, parseSource } from './complexity.js';

const MIN_ASSERTIONS = 1;
const ASSERT_SOURCES = new Set([
  'assert',
  'node:assert',
  'assert/strict',
  'node:assert/strict',
]);
const TEST_REGISTRARS = new Set(['test', 'it']);
const CALL = 'CallExpression';
const IDENT = 'Identifier';
const MEMBER = 'MemberExpression';

/**
 * Test-assertion violations across files.
 *
 * @param {string[]} files  absolute test-file paths.
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function testAssertionViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const ast = parseSource(readFileSync(file, 'utf8'), path.extname(file));
    const bindings = assertBindings(ast.program);
    for (const t of findTests(ast.program)) {
      checked++;
      const assertions = countAssertions(t.fn, bindings);
      if (assertions < MIN_ASSERTIONS) {
        violations.push({
          file: toRelPath(file, projectRoot),
          line: t.line,
          message: `'${t.name}' has ${assertions} assertion(s) — a test without assertions verifies nothing`,
        });
      }
    }
  }
  return { violations, checked };
}

// Local names bound to the assert module (default, namespace, and named —
// possibly renamed — imports).
function assertBindings(program) {
  const names = new Set();
  for (const stmt of program.body) {
    if (stmt.type === 'ImportDeclaration' && ASSERT_SOURCES.has(stmt.source.value)) {
      for (const s of stmt.specifiers) names.add(s.local.name);
    }
  }
  return names;
}

// Every test()/it() registration in the file (inside describe() callbacks
// too), with its body function, label, and line. Registrar modifiers like
// test.skip/it.only count; body-less forms (test.todo) cannot assert and
// are skipped.
function findTests(program) {
  const tests = [];
  walk(program, (n) => {
    if (n.type !== CALL) return;
    const kind = registrarOf(n.callee);
    const fn = n.arguments.at(-1);
    if (kind && isFunction(fn)) {
      tests.push({
        name: labelOf(n, kind),
        line: n.loc.start.line,
        fn,
      });
    }
  });
  return tests;
}

// The registrar a callee refers to ('test'/'it'), or null. Matches both
// `test(...)` and `test.skip(...)` / `it.only(...)` forms.
function registrarOf(callee) {
  const target =
    callee.type === IDENT ? callee : callee.type === MEMBER ? callee.object : null;
  return target?.type === IDENT && TEST_REGISTRARS.has(target.name) ? target.name : null;
}

function isFunction(node) {
  return node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression';
}

// The test's label: its first argument's string value, else the registrar.
function labelOf(call, kind) {
  return call.arguments[0]?.type === 'StringLiteral' ? call.arguments[0].value : kind;
}

// Assertion calls anywhere in the test body: direct calls of assert
// bindings (`assert(x)`, destructured `ok(x)`), member calls through an
// assert binding (`assert.strictEqual(...)`), and `t.assert.*` calls on
// the test-context parameter.
function countAssertions(fn, bindings) {
  const ctx = fn.params[0]?.type === IDENT ? fn.params[0].name : null;
  let count = 0;
  walk(fn, (n) => {
    if (n.type === CALL && isAssertionCall(n.callee, bindings, ctx)) count++;
  });
  return count;
}

function isAssertionCall(callee, bindings, ctx) {
  if (callee.type === IDENT) return bindings.has(callee.name);
  if (callee.type !== MEMBER) return false;
  return (
    isBindingRef(callee.object, bindings) ||
    (ctx !== null && isContextAssert(callee.object, ctx))
  );
}

function isBindingRef(object, bindings) {
  return object.type === IDENT && bindings.has(object.name);
}

// `<ctx>.assert` — the node:test context's assert sub-object.
function isContextAssert(object, ctx) {
  return (
    object.type === MEMBER &&
    object.object.type === IDENT &&
    object.object.name === ctx &&
    object.property.name === 'assert'
  );
}

function walk(node, fn) {
  if (!isNode(node)) return;
  fn(node);
  for (const child of childrenOf(node)) walk(child, fn);
}

/**
 * One-line summary mirroring the Dart gate: `M tests assert their
 * expectations`, or `N/M tests without assertions`.
 */
export function testAssertionsSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} tests assert their expectations`
    : `${violations}/${checked} tests without assertions`;
}

/**
 * The `test-assertions` command body. Takes only paths — any `--flag`
 * argument is a usage error that throws and surfaces as exit code 1.
 * Returns exit code 2 iff violations exist.
 */
export function runTestAssertions(argv, ctx) {
  const flag = argv.find((a) => a.startsWith('--'));
  if (flag) throw new Error(`unknown flag: ${flag}`);
  return runCheck(
    ctx,
    testFiles(argv, ctx.cwd),
    testAssertionViolations,
    testAssertionsSummary,
  );
}
