import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  magicConstantsSummary,
  magicConstantsViolations,
  runMagicConstants,
} from '../src/magicConstants.js';

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
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-magic-constants-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function violationsOf(source, name = 'x.js') {
  const root = fixture({ [name]: source });
  try {
    return magicConstantsViolations(
      [path.join(root, 'src', name)],
      root,
    ).violations;
  } finally {
    cleanup(root);
  }
}

test('hex color outside a const declaration is flagged', () => {
  const v = violationsOf('el.style.color = 0x3366ff;\n');
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
  assert.equal(v[0].message, 'hex color outside a constant declaration');
});

test('hex color in a const initializer is exempt, including call args', () => {
  const src = [
    "import { css } from 'x';",
    'const ACCENT = 0xff3366;',
    'const THEME = css({ color: 0x66ff33, base: 0x80112233 });',
    'let mut = 0xdeadbeef;',
  ].join('\n');
  const v = violationsOf(src);
  // Only the non-const `let` initializer is flagged.
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 4);
});

test('repeated numeric literal repeated 3+ times flags every occurrence', () => {
  const src = [
    'function f() {',
    '  if (a) return 86400;',
    '  if (b) return 86400;',
    '  return 86400;',
    '}',
  ].join('\n');
  const v = violationsOf(src);
  assert.equal(v.length, 3);
  assert.deepEqual(v.map((x) => x.line), [2, 3, 4]);
  assert.match(v[0].message, /literal 86400 repeats 3 times — extract a named constant/);
});

test('repeated string literal repeated 3+ times flags every occurrence', () => {
  const src = [
    "export const A = 'hello';",
    "export const B = 'hello';",
    "export const C = 'hello';",
  ].join('\n');
  const v = violationsOf(src);
  assert.equal(v.length, 3);
  assert.match(v[0].message, /literal hello repeats 3 times/);
});

test('strings shorter than 4 characters are ignored', () => {
  const v = violationsOf("const a = 'no'; const b = 'no'; const c = 'no';\n");
  assert.equal(v.length, 0);
});

test('two occurrences of a literal are not flagged', () => {
  const v = violationsOf('f(1234); g(1234);\n');
  assert.equal(v.length, 0);
});

test('clean file exits 0 with the passing summary', () => {
  const root = fixture({ 'ok.js': 'const LIMIT = 100;\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runMagicConstants([], ctx), 0);
    assert.match(ctx.lines.join(''), /1 files free of magic constants/);
  } finally {
    cleanup(root);
  }
});

test('violations exit 2 and print one line each plus the summary', () => {
  const root = fixture({
    'bad.js': 'a(0x112233);\nb(0x112233);\nc(0x112233);\n',
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runMagicConstants([], ctx), 2);
    const out = ctx.lines.join('');
    assert.match(out, /src\/bad\.js:1: hex color outside a constant declaration/);
    assert.match(out, /literal 0x112233 repeats 3 times/);
    assert.match(out, /6 magic constant\(s\) in 1 files/);
  } finally {
    cleanup(root);
  }
});

test('unknown flag is a usage error (exit 1)', () => {
  const root = fixture({ 'ok.js': 'const LIMIT = 100;\n' });
  try {
    const ctx = fakeCtx(root);
    assert.throws(() => runMagicConstants(['--nope'], ctx), /unknown flag: --nope/);
  } finally {
    cleanup(root);
  }
});

test('magic-constants over the repo itself finds no violations', () => {
  const ctx = fakeCtx(REPO_ROOT);
  assert.equal(runMagicConstants([], ctx), 0);
});

test('magicConstantsSummary lines', () => {
  assert.equal(magicConstantsSummary({ violations: 0, checked: 2 }), '2 files free of magic constants');
  assert.equal(magicConstantsSummary({ violations: 3, checked: 2 }), '3 magic constant(s) in 2 files');
});
