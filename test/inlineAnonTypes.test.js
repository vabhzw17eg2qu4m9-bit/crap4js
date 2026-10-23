import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseSource } from '../src/complexity.js';
import {
  inlineAnonTypesViolations,
  inlineAnonTypesSummary,
  parseInlineAnonTypesArgs,
  runInlineAnonTypes,
  signatureShapes,
} from '../src/inlineAnonTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli.js');

function fakeCtx(cwd) {
  const out = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    lines: out,
  };
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-anon-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function shapesOf(source) {
  return signatureShapes(parseSource(source, '.ts').program);
}

test('flags inline object literal in a function parameter annotation', () => {
  const root = fixture({
    'sig.ts': 'export function f(cb: { a: string }): void {}\n',
  });
  try {
    const r = runInlineAnonTypes(['src/sig.ts'], fakeCtx(root));
    assert.equal(r, 2);
    const { violations } = inlineAnonTypesViolations(
      [path.join(root, 'src', 'sig.ts')],
      root,
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 1);
    assert.match(violations[0].message, /inline anonymous type in signature/);
    assert.match(violations[0].message, /named interface\/type alias/);
  } finally {
    cleanup(root);
  }
});

test('flags tuple return type over the default arity cap (6 > 5)', () => {
  const root = fixture({
    'sig.ts':
      'export function f(): [string, number, number, number, number, number] { return null as never; }\n',
  });
  try {
    const ctx = fakeCtx(root);
    runInlineAnonTypes(['src/sig.ts'], ctx);
    assert.match(ctx.lines[0], /6 member\(s\).*members > max 5/);
  } finally {
    cleanup(root);
  }
});

test('tuple of exactly 5 members is flagged inline but not over the cap', () => {
  const root = fixture({
    'sig.ts': 'export function f(): [string, number, number, number, number] { return null as never; }\n',
  });
  try {
    const ctx = fakeCtx(root);
    const code = runInlineAnonTypes(['src/sig.ts'], ctx);
    assert.equal(code, 2);
    assert.match(ctx.lines[0], /5 member\(s\)/);
    assert.doesNotMatch(ctx.lines[0], /> max /);
  } finally {
    cleanup(root);
  }
});

test('flags shapes nested inside type arguments', () => {
  const root = fixture({
    'sig.ts': 'export function f(cb: Promise<{ r: string } | null>): void {}\n',
  });
  try {
    const { violations } = inlineAnonTypesViolations(
      [path.join(root, 'src', 'sig.ts')],
      root,
    );
    assert.equal(violations.length, 1);
  } finally {
    cleanup(root);
  }
});

test('only the outermost shape of a nested group is flagged', () => {
  const { shapes } = shapesOf('export function f(t: [string, { a: number }]): void {}\n');
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].members, 2);
});

test('named aliases and interfaces are blessed and not flagged', () => {
  const src = [
    'type Point = { x: number };',
    'interface Named { id: string }',
    'type Pair = [Point, Named];',
    'export function f(p: Point, n: Named): Pair { return null as never; }',
    '',
  ].join('\n');
  const { shapes, signatures } = shapesOf(src);
  assert.equal(signatures, 1);
  assert.equal(shapes.length, 0);
});

test('a function-type alias blesses nothing (upstream 4d844a4)', () => {
  const { shapes, signatures } = shapesOf('type F = (x: { b: number }) => void;\n');
  assert.equal(signatures, 1);
  assert.equal(shapes.length, 1);
});

test('a flow function-type alias blesses nothing either', () => {
  const root = fixture({
    'flow.js': 'type F = (x: { b: number }) => void;\n',
  });
  try {
    const { violations } = inlineAnonTypesViolations(
      [path.join(root, 'src', 'flow.js')],
      root,
    );
    assert.equal(violations.length, 1);
  } finally {
    cleanup(root);
  }
});

test('default-valued parameter annotations are flagged', () => {
  const root = fixture({
    'sig.ts': 'export function f(cb: { a: string } = null as never): void {}\n',
  });
  try {
    const { violations } = inlineAnonTypesViolations(
      [path.join(root, 'src', 'sig.ts')],
      root,
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].line, 1);
  } finally {
    cleanup(root);
  }
});

test('constructor parameter properties are flagged', () => {
  const root = fixture({
    'sig.ts': 'export class K { constructor(private p: { q: string }) {} }\n',
  });
  try {
    const { violations } = inlineAnonTypesViolations(
      [path.join(root, 'src', 'sig.ts')],
      root,
    );
    assert.equal(violations.length, 1);
  } finally {
    cleanup(root);
  }
});

test('methods, arrows, and declare functions are signatures too', () => {
  const src = [
    'export class K { m(w: { q: string }) { return w; } }',
    'export const g = (v: { z: number }) => v;',
    'declare function d(p: { s: number }): void;',
    '',
  ].join('\n');
  const { shapes, signatures } = shapesOf(src);
  assert.equal(signatures, 3);
  assert.equal(shapes.length, 3);
});

test('plain .js without type syntax is a documented no-op', () => {
  const root = fixture({
    'plain.js': 'export function f(a, b) { return a + b; }\nexport const g = (x) => x;\nclass K { m() {} }\n',
  });
  try {
    const code = runInlineAnonTypes(['src/plain.js'], fakeCtx(root));
    assert.equal(code, 0);
  } finally {
    cleanup(root);
  }
});

test('flow-annotated .js files ARE scanned (honest surface)', () => {
  const root = fixture({
    'flow.js': 'export function f(x: { a: string }) { return x; }\n',
  });
  try {
    const { violations } = inlineAnonTypesViolations(
      [path.join(root, 'src', 'flow.js')],
      root,
    );
    assert.equal(violations.length, 1);
  } finally {
    cleanup(root);
  }
});

test('--max-fields overrides the arity cap', () => {
  const root = fixture({
    'sig.ts': 'export function f(): [string, number, number] { return null as never; }\n',
  });
  try {
    const ctx = fakeCtx(root);
    runInlineAnonTypes(['src/sig.ts', '--max-fields', '2'], ctx);
    assert.match(ctx.lines[0], /3 member\(s\).*members > max 2/);
  } finally {
    cleanup(root);
  }
});

test('parseInlineAnonTypesArgs: defaults, =VALUE form, invalid number', () => {
  assert.deepEqual(parseInlineAnonTypesArgs([]), { maxFields: 5, paths: [] });
  assert.deepEqual(parseInlineAnonTypesArgs(['--max-fields=3', 'src']),
    { maxFields: 3, paths: ['src'] });
  assert.throws(() => parseInlineAnonTypesArgs(['--max-fields', 'abc']), /Invalid --max-fields/);
  assert.throws(() => parseInlineAnonTypesArgs(['--max-fields']), /requires a value/);
});

test('summary lines follow the gate convention', () => {
  assert.equal(
    inlineAnonTypesSummary({ violations: 0, checked: 7 }),
    '7 signatures checked, no inline anonymous types',
  );
  assert.equal(
    inlineAnonTypesSummary({ violations: 2, checked: 7 }),
    '2 inline anonymous types in signatures',
  );
});

test('CLI dispatch: violation exits 2, bad flag exits 1', () => {
  const root = fixture({
    'sig.ts': 'export function f(cb: { a: string }): void {}\n',
  });
  try {
    const bad = spawnSync(process.execPath, [CLI, 'inline-anon-types', 'src/sig.ts'],
      { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /src\/sig\.ts:1: inline anonymous type/);
    assert.match(bad.stdout, /1 inline anonymous types in signatures/);

    const usage = spawnSync(process.execPath, [CLI, 'inline-anon-types', '--max-fields', 'x'],
      { cwd: root, encoding: 'utf8' });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Invalid --max-fields/);
  } finally {
    cleanup(root);
  }
});
