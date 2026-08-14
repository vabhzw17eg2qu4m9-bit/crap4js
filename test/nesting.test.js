import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSource } from '../src/complexity.js';
import {
  maxNesting,
  nestingSummary,
  nestingViolations,
  runNesting,
} from '../src/nesting.js';

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
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-nesting-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// Deepest nesting of the first function declared in `source`.
function depthOf(source) {
  const ast = parseSource(source, '.js');
  const fn = ast.program.body[0];
  return maxNesting(fn.body);
}

test('function body is level 1; each control-flow construct adds one', () => {
  assert.equal(depthOf('function f() { return 1; }'), 1);
  assert.equal(depthOf('function f(a) { if (a) { return 1; } }'), 2);
  const nested = 'function f(a) { if (a) { for (;;) { while (a) { if (a) {} } } } }';
  assert.equal(depthOf(nested), 5);
});

test('try and switch count as nesting levels', () => {
  const src = 'function f(a) { try { switch (a) { case 1: break; } } catch (e) {} }';
  assert.equal(depthOf(src), 3);
});

test('nesting inside arrow bodies counts toward the enclosing function', () => {
  const src = 'function f(a) { const g = () => { if (a) { if (a) { if (a) { if (a) {} } } } }; }';
  assert.equal(depthOf(src), 5);
});

test('five nested constructs (depth 6) is a violation, four is not', () => {
  const six = 'function f(a) { if (a) { if (a) { if (a) { if (a) { if (a) {} } } } } }';
  assert.equal(depthOf(six), 6);
  const five = 'function f(a) { if (a) { if (a) { if (a) { if (a) {} } } } }';
  assert.equal(depthOf(five), 5);
});

test('deeply nested function is flagged with file:line and exits 2', () => {
  const root = fixture({
    'deep.js': [
      'function deep(a) {',
      '  if (a) { if (a) { if (a) { if (a) { if (a) { return 1; } } } } }',
      '}',
    ].join('\n'),
  });
  try {
    const ctx = fakeCtx(root);
    const code = runNesting([], ctx);
    assert.equal(code, 2);
    assert.match(ctx.lines.join(''), /src\/deep\.js:1: deep nesting=6 > max 5/);
    assert.match(ctx.lines.join(''), /1\/1 methods nested deeper than 5/);
  } finally {
    cleanup(root);
  }
});

test('shallow functions pass with exit 0 and a summary', () => {
  const root = fixture({ 'flat.js': 'function flat(a) { if (a) { return 1; } return 0; }' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runNesting([], ctx), 0);
    assert.match(ctx.lines.join(''), /1 methods within nesting 5/);
  } finally {
    cleanup(root);
  }
});

test('explicit path selection restricts the check (no whole-project skip)', () => {
  const root = fixture({
    'deep.js': 'function d(a) { if (a) { if (a) { if (a) { if (a) { if (a) {} } } } } }',
    'flat.js': 'function f(a) { if (a) { return 1; } return 0; }',
  });
  try {
    // Only the flat file is selected — the deep violation is out of scope.
    const ctx = fakeCtx(root);
    assert.equal(runNesting(['src/flat.js'], ctx), 0);
    // Selecting the deep file directly fails.
    const ctx2 = fakeCtx(root);
    assert.equal(runNesting([path.join(root, 'src', 'deep.js')], ctx2), 2);
  } finally {
    cleanup(root);
  }
});

test('nesting over the repo itself finds no violations', () => {
  const ctx = fakeCtx(REPO_ROOT);
  const { violations } = nestingViolations(
    [path.join(REPO_ROOT, 'src', 'complexity.js'), path.join(REPO_ROOT, 'src', 'cli.js')],
    REPO_ROOT,
  );
  assert.equal(violations.length, 0);
});

test('nestingSummary lines', () => {
  assert.equal(nestingSummary({ violations: 0, checked: 3 }), '3 methods within nesting 5');
  assert.equal(
    nestingSummary({ violations: 1, checked: 3 }),
    '1/3 methods nested deeper than 5',
  );
});
