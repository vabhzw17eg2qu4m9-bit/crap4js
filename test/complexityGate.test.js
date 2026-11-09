import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  complexitySummary,
  complexityViolations,
  parseComplexityArgs,
  runComplexity,
} from '../src/complexity.js';
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
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-complexity-gate-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// Cyclomatic 4: base 1 + if + conditional + logical and.
const BRANCHY = ['export function branchy(x) {', '  if (x && x > 0) { return 1; }', '  return x ? 2 : 3;', '}'].join('\n');

// Cyclomatic 11: base 1 plus ten plain ifs.
const HEAVY = [
  'export function heavy(x) {',
  ...Array.from({ length: 10 }, (_, i) => `  if (x === ${i}) { return ${i}; }`),
  '  return -1;',
  '}',
].join('\n');

test('function over the default CC limit is flagged, exit 2', () => {
  const root = fixture({ 'c.js': HEAVY });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runComplexity([], ctx), 2);
    assert.match(ctx.lines.join(''), /^src\/c\.js:1: heavy CC=11 > max 10$/m);
    assert.match(ctx.lines.join(''), /1\/1 functions over their cyclomatic limit 10/);
  } finally {
    cleanup(root);
  }
});

test('function exactly at the limit passes (boundary)', () => {
  const root = fixture({ 'c.js': BRANCHY });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runComplexity(['--max', '4'], ctx), 0);
    assert.match(ctx.lines.join(''), /1 functions within their cyclomatic limit 4/);
  } finally {
    cleanup(root);
  }
});

test('--max tightens the limit; --flag=VALUE accepted', () => {
  const root = fixture({ 'c.js': BRANCHY });
  try {
    assert.equal(runComplexity(['--max', '3'], fakeCtx(root)), 2);
    const ctx = fakeCtx(root);
    assert.equal(runComplexity(['--max=4'], ctx), 0);
    assert.match(ctx.lines.join(''), /within their cyclomatic limit 4/);
  } finally {
    cleanup(root);
  }
});

test('--metric cognitive scores by the cognitive rules and labels violations', () => {
  // Cognitive: +1 per if/conditional/logical-sequence, no nesting here → 3.
  const root = fixture({ 'c.js': BRANCHY });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runComplexity(['--metric', 'cognitive', '--max', '2'], ctx), 2);
    assert.match(ctx.lines.join(''), /branchy cognitive=3 > max 2/);
    assert.match(ctx.lines.join(''), /1\/1 functions over their cognitive limit 2/);
    const ok = fakeCtx(root);
    assert.equal(runComplexity(['--metric', 'cognitive', '--max', '3'], ok), 0);
  } finally {
    cleanup(root);
  }
});

test('nested and class methods carry qualified names', () => {
  const source = ['class C {', '  m(x) {', ...Array.from({ length: 10 }, (_, i) => `    if (x) { return ${i + 1}; }`), '    return 0;', '  }', '}'].join('\n');
  const root = fixture({ 'q.js': source });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runComplexity(['--max', '10'], ctx), 2);
    assert.match(ctx.lines.join(''), /C\.m CC=11 > max 10/);
  } finally {
    cleanup(root);
  }
});

test('violations report the function start line', () => {
  const source = ['const a = 1;', '', 'function branchy(x) {', '  if (x) { return 1; }', '  return x ? 2 : 3;', '}'].join('\n');
  const root = fixture({ 'l.js': source });
  try {
    const r = complexityViolations([path.join(root, 'src', 'l.js')], root, { max: 2 });
    assert.deepEqual(r.violations.map((v) => [v.file, v.line]), [['src/l.js', 3]]);
  } finally {
    cleanup(root);
  }
});

test('invalid metric and non-integer max are usage errors (exit 1)', () => {
  const root = fixture({ 'c.js': 'function a() { return 1; }' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(main(['complexity', '--metric', 'bogus'], ctx), 1);
    assert.match(ctx.errors.join(''), /invalid --metric bogus: expected cyclomatic or cognitive/);
    const ctx2 = fakeCtx(root);
    assert.equal(main(['complexity', '--max', '2.5'], ctx2), 1);
    assert.match(ctx2.errors.join(''), /--max must be an integer/);
  } finally {
    cleanup(root);
  }
});

test('unknown flag is a usage error', () => {
  assert.throws(() => parseComplexityArgs(['--limit=5']), /unknown flag: --limit/);
});

test('complexityViolations counts every checked function', () => {
  const source = ['export function a(x) { if (x) { return 1; } return 0; }', 'export const b = (x) => x;'].join('\n');
  const root = fixture({ 'n.js': source });
  try {
    const r = complexityViolations([path.join(root, 'src', 'n.js')], root, {});
    assert.equal(r.checked, 2);
    assert.equal(r.violations.length, 0);
  } finally {
    cleanup(root);
  }
});

test('complexitySummary lines', () => {
  assert.equal(complexitySummary({ violations: 0, checked: 4 }), '4 functions within their cyclomatic limit 10');
  assert.equal(complexitySummary({ violations: 2, checked: 4 }), '2/4 functions over their cyclomatic limit 10');
  assert.equal(complexitySummary({ violations: 0, checked: 4 }, 'cognitive', 5), '4 functions within their cognitive limit 5');
});
