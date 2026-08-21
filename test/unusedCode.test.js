import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runUnusedCode, unusedCodeSummary, unusedCodeViolations } from '../src/unusedCode.js';
import { gateFiles } from '../src/files.js';

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
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-unused-code-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test('never-referenced module-private declarations are flagged', () => {
  const root = fixture({
    'dead.js': [
      'const used = 1;',
      'const dead = 2;',
      'function usedFn() { return used; }',
      'function deadFn() {}',
      'class DeadClass {}',
      'export const api = usedFn;',
    ].join('\n'),
  });
  try {
    const { violations, checked } = unusedCodeViolations(gateFiles([], root), root);
    assert.equal(checked, 5);
    const names = violations.map((v) => v.message);
    assert.equal(violations.length, 3);
    assert.ok(names.some((m) => m.startsWith('dead is never referenced')));
    assert.ok(names.some((m) => m.startsWith('deadFn is never referenced')));
    assert.ok(names.some((m) => m.startsWith('DeadClass is never referenced')));
  } finally {
    cleanup(root);
  }
});

test('declaring a private name does not strip its references (0.7.1 regression)', () => {
  const root = fixture({
    // The reference sits inside a class body and textually precedes the
    // declaration — upstream 0.7.1 fixed declaring-side reference removal
    // flagging exactly this cross-class, same-module access as unused.
    'registry.js': [
      'class Registry {',
      '  register() { return helper(); }',
      '}',
      'function helper() { return 1; }',
      'export default Registry;',
    ].join('\n'),
  });
  try {
    const { violations, checked } = unusedCodeViolations(gateFiles([], root), root);
    assert.equal(checked, 2);
    assert.deepEqual(violations, []);
  } finally {
    cleanup(root);
  }
});

test('decorator identifiers count as references (decorated class not flagged)', () => {
  const root = fixture({
    // `dec` appears only as a decorator — the lexical identifier walk must
    // still see it, and the accessor-field class must parse at all.
    'decorated.js': [
      'function dec(t) { return t; }',
      'class A {',
      '  @dec accessor x = 1;',
      '}',
      'export default A;',
    ].join('\n'),
  });
  try {
    const { violations } = unusedCodeViolations(gateFiles([], root), root);
    assert.deepEqual(violations, []);
  } finally {
    cleanup(root);
  }
});

test('exported declarations are module-public and never flagged', () => {  const root = fixture({
    'api.js': [
      'const internal = 1;',
      'export const visible = internal;',
      'export function pub() {}',
      'export class K {}',
    ].join('\n'),
  });
  try {
    const { violations, checked } = unusedCodeViolations(gateFiles([], root), root);
    assert.equal(checked, 1); // only `internal` is module-private
    assert.equal(violations.length, 0);
  } finally {
    cleanup(root);
  }
});

test('a declaration referenced anywhere in its module (even a property key) is kept', () => {
  const root = fixture({
    'keep.js': [
      'const key = 1;',
      'export const obj = { key: 2 };',
      'let counter = 0;',
      'export const bump = () => counter++;',
    ].join('\n'),
  });
  try {
    const { violations } = unusedCodeViolations(gateFiles([], root), root);
    assert.equal(violations.length, 0);
  } finally {
    cleanup(root);
  }
});

test('violations print file:line and exit 2', () => {
  const root = fixture({ 'dead.js': 'const dead = 1;\nexport const x = 2;\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runUnusedCode([], ctx), 2);
    assert.match(ctx.lines.join(''), /src\/dead\.js:1: dead is never referenced in the module/);
    assert.match(ctx.lines.join(''), /1 unused declarations in 1 module-scope declarations/);
  } finally {
    cleanup(root);
  }
});

test('explicit path selection skips with a message and exits 0', () => {
  const ctx = fakeCtx(REPO_ROOT);
  assert.equal(runUnusedCode(['src/cli.js'], ctx), 0);
  assert.match(ctx.lines.join(''), /not meaningful for a partial selection/);
});

test('unused-code over the repo itself finds no violations', () => {
  const { violations } = unusedCodeViolations(gateFiles([], REPO_ROOT), REPO_ROOT);
  assert.equal(violations.length, 0);
});

test('unusedCodeSummary lines', () => {
  assert.equal(unusedCodeSummary({ violations: 0, checked: 4 }), '4 declarations all referenced');
  assert.equal(
    unusedCodeSummary({ violations: 2, checked: 4 }),
    '2 unused declarations in 4 module-scope declarations',
  );
});
