import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractMethodsWithNodes } from '../src/complexity.js';
import { methodSizeSummary, methodSizeViolations, parseMethodSizeArgs, runMethodSize } from '../src/methodSize.js';
import { main } from '../src/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fakeCtx(cwd) {
  const out = [];
  const err = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    lines: out,
    errors: err,
  };
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-method-size-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// A method whose body spans exactly `lines` physical lines.
function longMethod(lines, name = 'm') {
  const body = Array.from({ length: lines - 2 }, (_, i) => `  const x${i} = ${i};`);
  return [`function ${name}() {`, ...body, '}'].join('\n');
}

test('constructors become entries only with includeConstructors', () => {
  const source = ['class C {', '  constructor(a) { this.a = a; }', '  m() { return 1; }', '}'].join('\n');
  const plain = extractMethodsWithNodes(source, { ext: '.js' });
  assert.deepEqual(plain.map((m) => m.name), ['C.m']);
  const withCtors = extractMethodsWithNodes(source, { ext: '.js', includeConstructors: true });
  assert.deepEqual(withCtors.map((m) => m.name), ['C.constructor', 'C.m']);
  assert.equal(withCtors[0].node.kind, 'constructor');
});

test('long method is flagged at its start line, exit 2', () => {
  const root = fixture({ 'big.js': longMethod(62, 'tooLong') });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runMethodSize([], ctx), 2);
    assert.match(ctx.lines.join(''), /^src\/big\.js:1: tooLong has 62 lines > max 60$/m);
    assert.match(ctx.lines.join(''), /1 violations in 1 methods over their size limits/);
  } finally {
    cleanup(root);
  }
});

test('method of exactly 60 body lines passes (boundary)', () => {
  const root = fixture({ 'edge.js': longMethod(60, 'edge') });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runMethodSize([], ctx), 0);
    assert.match(ctx.lines.join(''), /1 methods within their size limits/);
  } finally {
    cleanup(root);
  }
});

test('--max-lines tightens the limit', () => {
  const root = fixture({ 'm.js': longMethod(10, 'm') });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runMethodSize(['--max-lines', '9'], ctx), 2);
    assert.match(ctx.lines.join(''), /m has 10 lines > max 9/);
  } finally {
    cleanup(root);
  }
});

test('over-param method is flagged; exactly max params passes', () => {
  const root = fixture({
    'p.js': [
      'function seven(a, b, c, d, e, f, g) { return a; }',
      'function six(a, b, c, d, e, f) { return a; }',
    ].join('\n'),
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runMethodSize([], ctx), 2);
    assert.match(ctx.lines.join(''), /^src\/p\.js:1: seven has 7 params > max 6$/m);
    assert.doesNotMatch(ctx.lines.join(''), /six has/);
    assert.match(ctx.lines.join(''), /1 violations in 2 methods over their size limits/);
  } finally {
    cleanup(root);
  }
});

test('--max-params loosens the limit', () => {
  const root = fixture({ 'p.js': 'function seven(a, b, c, d, e, f, g) { return a; }' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runMethodSize(['--max-params', '7'], ctx), 0);
  } finally {
    cleanup(root);
  }
});

test('constructors are checked for params only: long constructor passes, fat one is flagged', () => {
  const body = Array.from({ length: 70 }, (_, i) => `  this.x${i} = ${i};`);
  const source = [
    'class C {',
    '  constructor(a, b, c, d, e, f, g, h) {',
    ...body,
    '  }',
    '  ok() { return 1; }',
    '}',
  ].join('\n');
  const root = fixture({ 'ctor.js': source });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runMethodSize([], ctx), 2);
    const printed = ctx.lines.join('');
    // No line-count violation for the constructor (params-only upstream rule)…
    assert.doesNotMatch(printed, /C\.constructor has \d+ lines/);
    // …but the parameter count is checked.
    assert.match(printed, /^src\/ctor\.js:2: C\.constructor has 8 params > max 6$/m);
    assert.match(printed, /1 violations in 2 methods over their size limits/);
  } finally {
    cleanup(root);
  }
});

test('class methods carry the class-qualified name', () => {
  const root = fixture({ 'cls.js': ['class Order {', '  ship(a, b, c, d, e, f, g) { return a; }', '}'].join('\n') });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runMethodSize([], ctx), 2);
    assert.match(ctx.lines.join(''), /Order\.ship has 7 params > max 6/);
  } finally {
    cleanup(root);
  }
});

test('non-integer limits are usage errors (exit 1)', () => {
  const root = fixture({ 'a.js': 'function a() {}' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(main(['method-size', '--max-params', '6.5'], ctx), 1);
    assert.match(ctx.errors.join(''), /--max-params must be an integer/);
  } finally {
    cleanup(root);
  }
});

test('unknown flag is a usage error', () => {
  assert.throws(() => parseMethodSizeArgs(['--limit=5']), /unknown flag: --limit/);
});

test('methodSizeViolations reports both kinds for one method', () => {
  const body = Array.from({ length: 64 }, (_, i) => `  const x${i} = ${i};`);
  const source = ['function both(a, b, c, d, e, f, g) {', ...body, '}'].join('\n');
  const root = fixture({ 'both.js': source });
  try {
    const r = methodSizeViolations([path.join(root, 'src', 'both.js')], root, {});
    assert.equal(r.checked, 1);
    assert.deepEqual(
      r.violations.map((v) => v.message),
      ['both has 66 lines > max 60', 'both has 7 params > max 6'],
    );
    assert.deepEqual(r.violations.map((v) => v.line), [1, 1]);
  } finally {
    cleanup(root);
  }
});

test('methodSizeSummary lines', () => {
  assert.equal(methodSizeSummary({ violations: 0, checked: 3 }), '3 methods within their size limits');
  assert.equal(methodSizeSummary({ violations: 2, checked: 3 }), '2 violations in 3 methods over their size limits');
});
