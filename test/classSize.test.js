import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSource } from '../src/complexity.js';
import {
  classSizeSummary,
  classSizeViolations,
  classTotals,
  runClassSize,
} from '../src/classSize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function fakeCtx(cwd) {
  const out = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    lines: out,
  };
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-class-size-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function totalsOf(source) {
  const ast = parseSource(source, '.js');
  return classTotals(ast.program);
}

test('counts concrete methods, excludes constructors, sums WMC', () => {
  const src = [
    'class A {',
    '  constructor() {}',
    '  m() { if (a) {} }',
    '  n() { return b ? 1 : 0; }',
    '  o() {}',
    '}',
  ].join('\n');
  const [a] = totalsOf(src);
  assert.equal(a.name, 'A');
  assert.equal(a.methods, 3);
  // m: 1 + if = 2, n: 1 + ternary = 2, o: 1 → WMC 5.
  assert.equal(a.wmc, 5);
});

test('nested classes are attributed to their own class', () => {
  const src = 'class Outer { m() {} get x() { const I = class { inner() {} }; return I; } }';
  const totals = totalsOf(src);
  assert.deepEqual(
    totals.map((t) => [t.name, t.methods]),
    [['Outer', 2], ['<anonymous>', 1]],
  );
});

test('god class with 26 methods is flagged', () => {
  const methods = Array.from({ length: 26 }, (_, i) => `  m${i}() {}`).join('\n');
  const root = fixture({ 'god.js': `class God {\n${methods}\n}\n` });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runClassSize([], ctx), 2);
    assert.match(ctx.lines.join(''), /src\/god\.js:1: God has 26 methods > max 25/);
  } finally {
    cleanup(root);
  }
});

test('high WMC with few methods is flagged', () => {
  const branches = 'if (a) {} '.repeat(85);
  const root = fixture({ 'hot.js': `class Hot { m() { ${branches} } }\n` });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runClassSize([], ctx), 2);
    assert.match(ctx.lines.join(''), /Hot WMC=\d+ > max 80/);
  } finally {
    cleanup(root);
  }
});

test('small well-factored classes pass with exit 0', () => {
  const root = fixture({ 'ok.js': 'class Ok { a() {} b() {} }\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runClassSize([], ctx), 0);
    assert.match(ctx.lines.join(''), /1 classes within 25 methods\/WMC 80/);
  } finally {
    cleanup(root);
  }
});

test('top-level functions are not attributed to a class', () => {
  const src = 'function top() {}';
  assert.equal(totalsOf(src).length, 0);
});

test('class-size over the repo itself finds no violations', () => {
  const { violations } = classSizeViolations(
    [path.join(REPO_ROOT, 'src', 'complexity.js'), path.join(REPO_ROOT, 'src', 'files.js')],
    REPO_ROOT,
  );
  assert.equal(violations.length, 0);
});

test('classSizeSummary lines', () => {
  assert.equal(classSizeSummary({ violations: 0, checked: 2 }), '2 classes within 25 methods/WMC 80');
  assert.equal(
    classSizeSummary({ violations: 1, checked: 2 }),
    '1 violations in 2 classes over 25 methods/WMC 80',
  );
});
