import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parsePublicDocsArgs, publicDocsSummary, publicDocsViolations, runPublicDocs } from '../src/publicDocs.js';
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
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-public-docs-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

const DOCGED = [
  '/** Ships the order. */',
  'export function ship(x) {',
  '  return x;',
  '}',
].join('\n');

test('exported function without JSDoc is flagged; documented one passes', () => {
  const root = fixture({
    'a.js': ['export function ship(x) {', '  return x;', '}'].join('\n'),
    'b.js': DOCGED,
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs([], ctx), 2);
    const printed = ctx.lines.join('');
    assert.match(printed, /^src\/a\.js:1: missing JSDoc on function "ship"$/m);
    // b.js contributes nothing.
    assert.doesNotMatch(printed, /b\.js/);
    assert.match(printed, /1\/2 public declarations missing JSDoc/);
  } finally {
    cleanup(root);
  }
});

test('plain block comments and line comments are not JSDoc', () => {
  const root = fixture({
    'a.js': ['/* ships the order */', 'export function ship(x) { return x; }'].join('\n'),
    'b.js': ['// ships the order', 'export function send(x) { return x; }'].join('\n'),
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs([], ctx), 2);
    const printed = ctx.lines.join('');
    assert.match(printed, /missing JSDoc on function "ship"/);
    assert.match(printed, /missing JSDoc on function "send"/);
  } finally {
    cleanup(root);
  }
});

test('a blank line between doc and declaration breaks the adjacency', () => {
  const source = ['/** Ships the order. */', '', 'export function ship(x) { return x; }'].join('\n');
  const root = fixture({ 'a.js': source });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs([], ctx), 2);
    assert.match(ctx.lines.join(''), /missing JSDoc on function "ship"/);
  } finally {
    cleanup(root);
  }
});

test('non-exported declarations are not the public surface', () => {
  const source = ['function helper(x) { return x; }', 'class Private { m() { return 1; } }'].join('\n');
  const root = fixture({ 'a.js': source });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs([], ctx), 0);
    assert.match(ctx.lines.join(''), /0 public declarations documented/);
  } finally {
    cleanup(root);
  }
});

test('exported class and its public methods are checked; constructor and #private are exempt', () => {
  const source = [
    '/** The order. */',
    'export class Order {',
    '  /** Builds one. */',
    '  constructor(x) { this.x = x; }',
    '  /** Ships it. */',
    '  ship() { return this.x; }',
    '  deliver() { return this.x; }',
    '  #hide() { return 1; }',
    '}',
  ].join('\n');
  const root = fixture({ 'a.js': source });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs([], ctx), 2);
    const printed = ctx.lines.join('');
    assert.match(printed, /^src\/a\.js:7: missing JSDoc on method "deliver"$/m);
    assert.doesNotMatch(printed, /"constructor"/);
    assert.doesNotMatch(printed, /#hide/);
    // checked: Order (class), ship, deliver — constructor/#hide exempt.
    assert.match(printed, /1\/3 public declarations missing JSDoc/);
  } finally {
    cleanup(root);
  }
});

test('documented class with fully documented methods passes', () => {
  const source = [
    '/** The order. */',
    'export class Order {',
    '  /** Ships it. */',
    '  ship() { return 1; }',
    '}',
  ].join('\n');
  const root = fixture({ 'a.js': source });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs([], ctx), 0);
    assert.match(ctx.lines.join(''), /2 public declarations documented/);
  } finally {
    cleanup(root);
  }
});

test('export const arrow functions count as exported functions', () => {
  const root = fixture({
    'a.js': ['export const ship = (x) => x;', 'export const send = (x) => x;'].join('\n'),
    'b.js': ['/** Sends. */', 'export const send = (x) => x;'].join('\n'),
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs([], ctx), 2);
    const printed = ctx.lines.join('');
    assert.match(printed, /missing JSDoc on function "ship"/);
    assert.match(printed, /missing JSDoc on function "send"/);
    assert.doesNotMatch(printed, /b\.js/);
  } finally {
    cleanup(root);
  }
});

test('export default named declarations are checked', () => {
  const root = fixture({ 'a.js': ['export default function ship(x) { return x; }'].join('\n') });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs([], ctx), 2);
    assert.match(ctx.lines.join(''), /missing JSDoc on function "ship"/);
  } finally {
    cleanup(root);
  }
});

test('--exclude removes a file from the check', () => {
  const root = fixture({
    'keep.js': ['export function ship(x) { return x; }'].join('\n'),
    'skipme.js': ['export function send(x) { return x; }'].join('\n'),
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs(['--exclude', '**/skipme.js'], ctx), 2);
    assert.doesNotMatch(ctx.lines.join(''), /skipme/);
  } finally {
    cleanup(root);
  }
});

test('explicit path selection restricts the check', () => {
  const root = fixture({
    'a.js': ['export function ship(x) { return x; }'].join('\n'),
    'b.js': ['export function send(x) { return x; }'].join('\n'),
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runPublicDocs([path.join(root, 'src', 'a.js')], ctx), 2);
    const printed = ctx.lines.join('');
    assert.match(printed, /"ship"/);
    assert.doesNotMatch(printed, /"send"/);
  } finally {
    cleanup(root);
  }
});

test('publicDocsViolations counts only public declarations as checked', () => {
  const source = ['export function a() {}', 'function b() {}', 'export const c = () => 1;'].join('\n');
  const root = fixture({ 'a.js': source });
  try {
    const r = publicDocsViolations([path.join(root, 'src', 'a.js')], root, {});
    assert.equal(r.checked, 2);
    assert.deepEqual(
      r.violations.map((v) => v.line),
      [1, 3],
    );
  } finally {
    cleanup(root);
  }
});

test('usage errors exit 1', () => {
  const root = fixture({ 'a.js': 'export function a() {}' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(main(['public-docs', '--max=5'], ctx), 1);
    assert.match(ctx.errors.join(''), /unknown flag: --max/);
  } finally {
    cleanup(root);
  }
});

test('publicDocsSummary lines', () => {
  assert.equal(publicDocsSummary({ violations: 0, checked: 5 }), '5 public declarations documented');
  assert.equal(publicDocsSummary({ violations: 2, checked: 5 }), '2/5 public declarations missing JSDoc');
});
