import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSource } from '../src/complexity.js';
import {
  classWeights,
  runWeightOfClass,
  weightSummary,
  weightViolations,
} from '../src/weightOfClass.js';

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
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-weight-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function weightsOf(source) {
  const ast = parseSource(source, '.js');
  return classWeights(ast.program);
}

test('public instance fields and methods are counted; static/private are not', () => {
  const src = [
    'class A {',
    '  static sField = 1;',
    '  #priv = 2;',
    '  pub = 3;',
    '  static sMethod() {}',
    '  constructor() {}',
    '  m() {}',
    '  get g() { return 1; }',
    '}',
  ].join('\n');
  const [a] = weightsOf(src);
  assert.equal(a.fields, 1);
  assert.equal(a.members, 3); // pub + m + g
  assert.ok(Math.abs(a.weight - 1 / 3) < 1e-9);
});

test('classes without public instance fields are never flagged (weight 0)', () => {
  const src = 'class Behavior { m() {} n() {} }';
  const [b] = weightsOf(src);
  assert.equal(b.fields, 0);
  assert.equal(b.weight, 0);
});

test('data-heavy class (2 fields, 1 method) is flagged and exits 2', () => {
  const root = fixture({ 'bag.js': 'class DataBag { a = 1; b = 2; only() {} }\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runWeightOfClass([], ctx), 2);
    assert.match(
      ctx.lines.join(''),
      /src\/bag\.js:1: DataBag data weight 0\.67 > max 0\.33/,
    );
  } finally {
    cleanup(root);
  }
});

test('balanced class (1 field, 3 methods → 0.25) passes', () => {
  const root = fixture({ 'ok.js': 'class Ok { v = 1; a() {} b() {} c() {} }\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runWeightOfClass([], ctx), 0);
    assert.match(ctx.lines.join(''), /1 classes within weight 0\.33/);
  } finally {
    cleanup(root);
  }
});

test('weight-of-class over the repo itself finds no violations', () => {
  const { violations } = weightViolations(
    [path.join(REPO_ROOT, 'src', 'complexity.js'), path.join(REPO_ROOT, 'src', 'cli.js')],
    REPO_ROOT,
  );
  assert.equal(violations.length, 0);
});

test('weightSummary lines', () => {
  assert.equal(weightSummary({ violations: 0, checked: 2 }), '2 classes within weight 0.33');
  assert.equal(weightSummary({ violations: 1, checked: 2 }), '1/2 classes over weight 0.33');
});
