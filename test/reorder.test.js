import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { parseSource, parseTokenized } from '../src/complexity.js';
import { reorderSource, runReorder } from '../src/reorder.js';
import { main } from '../src/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Sorted token stream of `code` — the transform moves tokens, never adds
// or drops them, so the multiset must survive a reorder exactly.
function sortedTokens(code) {
  const { tokens } = parseTokenized(code, '.js');
  return tokens
    .map((t) => (typeof t.type === 'string' ? t.type : `${t.type.label}:${t.value}`))
    .sort()
    .join(' ');
}

// Asserts the full consistency contract for `src`: idempotent, token
// multiset preserved, and the output parses.
function expectConsistent(src, ext = '.js') {
  const once = reorderSource(src, ext);
  assert.equal(reorderSource(once, ext), once, 'must be idempotent');
  assert.equal(sortedTokens(once), sortedTokens(src), 'token multiset preserved');
  parseSource(once, ext);
  return once;
}

function fakeCtx(cwd) {
  const out = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    lines: out,
  };
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-reorder-'));
  for (const [name, source] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return root;
}

test('orders members: static fields, fields, constructor, static methods, accessors, methods, private', () => {
  const src = [
    'class A {',
    '  #last() {}',
    '  m() {}',
    '  get g() {}',
    '  static s() {}',
    '  constructor() {}',
    '  x = 0;',
    '  static top = 1;',
    '}',
  ].join('\n');
  const out = expectConsistent(src);
  const order = [
    out.indexOf('static top'),
    out.indexOf('x = 0;'),
    out.indexOf('constructor'),
    out.indexOf('static s()'),
    out.indexOf('get g()'),
    out.indexOf('m() {}'),
    out.indexOf('#last()'),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('kind wins over staticness: static accessors are accessors, static #m is private', () => {
  // static sm buckets as a static METHOD; the getters/setter (even the
  // private static #g) bucket as ACCESSORS after it; static #sp is a
  // PRIVATE method. Upstream FINAL buckets isStatic first, so a Dart
  // static getter lands in static methods — deliberate divergence.
  const src = [
    'class A {',
    '  static #sp() {}',
    '  static get #g() {}',
    '  static get g() {}',
    '  static set g(v) {}',
    '  static sm() {}',
    '}',
  ].join('\n').concat('\n');
  const out = expectConsistent(src);
  assert.equal(
    out,
    'class A {\n'
    + '  static sm() {}\n\n'
    + '  static get #g() {}\n\n'
    + '  static get g() {}\n\n'
    + '  static set g(v) {}\n\n'
    + '  static #sp() {}\n'
    + '}\n',
  );
});

test('static blocks reorder with static fields', () => {
  const src = 'class A {\n  m() {}\n  static { init(); }\n}\n';
  const out = expectConsistent(src);
  assert.ok(out.indexOf('static { init(); }') < out.indexOf('m() {}'));
});

test('stable partition: same-kind members keep their relative order', () => {
  const src = 'class A {\n  b() {}\n  a() {}\n  static z = 1;\n  static y = 2;\n}\n';
  const out = expectConsistent(src);
  assert.ok(out.indexOf('b()') < out.indexOf('a()'), 'method order kept');
  assert.ok(out.indexOf('z = 1;') < out.indexOf('y = 2;'), 'static field order kept');
});

test('decorated members carry their decorators', () => {
  const src = 'class A {\n  m() {}\n  @dec() static x = 1;\n}\n';
  const out = expectConsistent(src);
  assert.ok(out.indexOf('@dec() static x = 1;') < out.indexOf('m() {}'));
});

test('already-canonical classes stay byte-identical whatever their layout', () => {
  for (const src of [
    'class A { x = 0; m() {} }\n',
    'class A {\n  x = 0; m() {}\n}\n',
    'class A {\n  x = 0;\n\n  m() {}\n}\n',
    'class A {\n  m() {}\n\n  // trailing orphan note\n}\n',
  ]) {
    assert.equal(reorderSource(src, '.js'), src);
    expectConsistent(src);
  }
});

test('single-line non-canonical class is moved and normalized', () => {
  const out = expectConsistent('class A { m() {} static x = 1; }\n');
  assert.equal(out, 'class A { static x = 1;\n\n m() {} }\n');
});

test('member on the class header line keeps the header', () => {
  const src = 'class A { // trailing\n  m() {}\n  x = 0;\n}\n';
  const out = expectConsistent(src);
  assert.equal(out, 'class A { // trailing\n  x = 0;\n\n  m() {}\n}\n');
});

test('a // class doc above the opener is never stolen', () => {
  const src = '// Doc for the class.\nclass A {\n  m() {}\n  x = 0;\n}\n';
  const out = expectConsistent(src);
  assert.equal(out, '// Doc for the class.\nclass A {\n  x = 0;\n\n  m() {}\n}\n');
});

test('a // block separated by ONE blank line moves with its member', () => {
  const src = 'class A {\n  m() {}\n\n  // note\n  x = 0;\n}\n';
  const out = expectConsistent(src);
  assert.equal(out, 'class A {\n  // note\n  x = 0;\n\n  m() {}\n}\n');
});

test('a blank-blank gap detaches the comment from the member', () => {
  const src = 'class A {\n  m() {}\n\n\n  // note\n  x = 0;\n}\n';
  const out = expectConsistent(src);
  assert.equal(out, 'class A {\n  // note\n  x = 0;\n\n  m() {}\n}\n');
});

test('block doc comments are carried', () => {
  const src = 'class A {\n  m() {}\n\n  /**\n   * Field docs.\n   */\n  x = 0;\n}\n';
  const out = expectConsistent(src);
  assert.ok(out.indexOf('/**\n   * Field docs.\n   */') < out.indexOf('m() {}'));
  assert.ok(out.includes('/**\n   * Field docs.\n   */\n  x = 0;'));
});

test('a detached block doc (blank line above) travels with its member', () => {
  const src = 'class A {\n  m() {}\n\n  /* unrelated note */\n\n  x = 0;\n}\n';
  const out = expectConsistent(src);
  // x (and the note floating above it) move above m; nothing is dropped.
  assert.ok(out.indexOf('/* unrelated note */') < out.indexOf('x = 0;'));
  assert.ok(out.indexOf('x = 0;') < out.indexOf('m() {}'));
});

test('an orphan comment before the first member moves only when attached', () => {
  // ONE blank between `// lead` and m() attaches the comment to the member.
  const attached = expectConsistent('class A {\n\n  // lead\n\n  m() {}\n  x = 0;\n}\n');
  assert.ok(attached.includes('// lead\n\n  m() {}'));
  assert.ok(attached.startsWith('class A {\n\n  x = 0;'));
  // TWO blanks detach it: the comment no longer travels with m() and
  // exactly one copy of it remains, above the reordered members.
  const detached = expectConsistent('class A {\n  // lead\n\n\n  m() {}\n  x = 0;\n}\n');
  assert.equal(detached.split('// lead').length - 1, 1, 'stays put, exactly once');
  assert.ok(detached.indexOf('// lead') < detached.indexOf('x = 0;'));
  assert.ok(detached.indexOf('x = 0;') < detached.indexOf('m() {}'));
});

test('a comment that looks like code is carried, not parsed', () => {
  const src = 'class A {\n  m() {}\n\n  // fake() {}\n  x = 0;\n}\n';
  const out = expectConsistent(src);
  assert.ok(out.includes('// fake() {}\n  x = 0;'));
});

test('CRLF files keep their line endings', () => {
  const src = 'class A {\r\n  m() {}\r\n  static x = 1;\r\n}\r\n';
  const out = expectConsistent(src);
  assert.equal(out.replaceAll('\r\n', '').includes('\n'), false);
  assert.ok(out.endsWith('}\r\n'));
});

test('a file without a trailing newline is preserved', () => {
  const src = 'class A {\n  m() {}\n  static x = 1;\n}';
  const out = expectConsistent(src);
  assert.ok(out.endsWith('}'));
  assert.equal(out.endsWith('}\n'), false);
});

test('empty files, comment-only files and empty classes are untouched', () => {
  for (const src of ['', '// only a comment\n', '/* block only */\n', 'class A {}\n']) {
    assert.equal(reorderSource(src, '.js'), src, `input: "${src}"`);
    expectConsistent(src);
  }
});

test('export and export default classes are reordered', () => {
  const src = 'export class B {\n  m() {}\n  static x = 1;\n}\nexport default class C {\n  n() {}\n  y = 2;\n}\n';
  const out = expectConsistent(src);
  assert.ok(out.indexOf('static x = 1;') < out.indexOf('m() {}'));
  assert.ok(out.indexOf('y = 2;') < out.indexOf('n() {}'));
});

test('nested classes and class expressions are left alone', () => {
  const src = 'const E = class { m() {} x = 0; };\nclass A {\n  wrap() { return class { n() {} y = 1; }; }\n}\n';
  assert.equal(reorderSource(src, '.js'), src);
});

test('TS enums are never reordered', () => {
  const src = 'enum E {\n  B,\n  A,\n}\n';
  assert.equal(reorderSource(src, '.ts'), src);
});

test('parse errors throw', () => {
  assert.throws(() => reorderSource('class A {', '.js'));
  assert.throws(() => reorderSource('class A { m() {} +++ }\n', '.js'));
});

// The consistency battery: every fixture must (1) be idempotent, (2)
// preserve the token multiset, and (3) produce a file that parses.
const FIXTURES = {
  'kitchen-sink': [
    '// Leading file comment.',
    'class Kitchen {',
    '  // note on state',
    '  static counter = 0;',
    '',
    '  label = "x";',
    '',
    '  constructor() {}',
    '',
    '  static build() {}',
    '',
    '  get area() {}',
    '',
    '  set area(v) {}',
    '',
    '  @override',
    '  toString() {}',
    '',
    '  #quiet() {}',
    '}',
  ].join('\n'),
  'comments-everywhere': [
    '// leading file comment',
    'class A {',
    '  // one',
    '  // two',
    '  a = 0;',
    '',
    '  /* block */',
    '  b() {}',
    '',
    '  c() {}',
    '',
    '  // before d',
    '  d() {}',
    '}',
    '',
    '// between classes',
    '',
    'class B {',
    '  x() {}',
    '',
    '  y = 0;',
    '}',
  ].join('\n'),
  'mixed-order-repeat': [
    'class C {',
    '  later() {}',
    '',
    '  middle = 0;',
    '',
    '  static first = 1;',
    '',
    '  #last() {}',
    '',
    '  middle2 = "two";',
    '',
    '  static firstStatic = 2;',
    '}',
  ].join('\n'),
  accessor: 'class D {\n  static get sg() {}\n  set s(v) {}\n  get g() {}\n  m() {}\n}\n',
  'shared-line': 'class E { a() {} b() {} x = 0; }\n',
};

for (const [name, src] of Object.entries(FIXTURES)) {
  test(`fixture ${name}: idempotent, token-preserving, parseable`, () => {
    const input = `${src}\n`;
    const once = reorderSource(input, '.js');
    assert.equal(reorderSource(once, '.js'), once, `${name}: idempotent`);
    assert.equal(sortedTokens(once), sortedTokens(input), `${name}: token multiset preserved`);
    parseSource(once, '.js');
  });
}

test('invariants hold on real repository files', () => {
  const files = [
    'src/reorder.js',
    'src/complexity.js',
    'src/files.js',
    'src/memory.js',
    'src/mutationCache.js',
    'src/cli.js',
  ];
  for (const rel of files) {
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const once = reorderSource(src, path.extname(rel));
    assert.equal(reorderSource(once, path.extname(rel)), once, `${rel}: idempotent`);
    assert.equal(sortedTokens(once), sortedTokens(src), `${rel}: token multiset preserved`);
  }
});

test('reorder command writes files and exits 0', () => {
  const root = fixture({ 'src/a.js': 'class A {\n  m() {}\n  static x = 1;\n}\n' });
  try {
    const code = main(['reorder'], fakeCtx(root));
    assert.equal(code, 0);
    assert.equal(
      readFileSync(path.join(root, 'src', 'a.js'), 'utf8'),
      'class A {\n  static x = 1;\n\n  m() {}\n}\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run lists files, writes nothing, exits 2', () => {
  const messy = 'class A {\n  m() {}\n  static x = 1;\n}\n';
  const root = fixture({ 'src/a.js': messy });
  try {
    const ctx = fakeCtx(root);
    const code = main(['reorder', '--dry-run'], ctx);
    assert.equal(code, 2);
    assert.equal(readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), messy);
    assert.ok(ctx.lines.join('').includes('would reorder src/a.js'));
    assert.ok(ctx.lines.join('').includes('1 of 1 files would be reordered.'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical files exit 0 in both modes', () => {
  const canonical = 'class A {\n  static x = 1;\n\n  m() {}\n}\n';
  const root = fixture({ 'src/a.js': canonical });
  try {
    const ctx = fakeCtx(root);
    assert.equal(main(['reorder'], ctx), 0);
    assert.equal(main(['reorder', '--dry-run'], ctx), 0);
    assert.ok(ctx.lines.join('').includes('All 1 files already canonical.'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parse errors are skipped with a note, the run continues', () => {
  const root = fixture({
    'src/broken.js': 'class A { +++\n',
    'src/good.js': 'class A {\n  m() {}\n  x = 0;\n}\n',
  });
  try {
    const ctx = fakeCtx(root);
    const code = main(['reorder'], ctx);
    assert.equal(code, 0);
    assert.ok(ctx.lines.join('').includes('skipped (parse error): src/broken.js'));
    assert.ok(readFileSync(path.join(root, 'src', 'good.js'), 'utf8').includes('x = 0;\n\n  m() {}'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit paths are honored, unknown flags fail, empty selections exit 0', () => {
  const root = fixture({ 'lib/b.js': 'class B {\n  m() {}\n  x = 0;\n}\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(main(['reorder', 'lib'], ctx), 0);
    assert.ok(ctx.lines.join('').includes('reordered lib/b.js'));
    assert.equal(main(['reorder', '--bogus'], fakeCtx(root)), 1);
    const empty = fixture({});
    try {
      const ctx2 = fakeCtx(empty);
      assert.equal(main(['reorder'], ctx2), 0);
      assert.ok(ctx2.lines.join('').includes('No source files found under: src'));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runReorder on a directory walks source files recursively', () => {
  const root = fixture({ 'pkg/deep/c.js': 'class C {\n  m() {}\n  x = 0;\n}\n' });
  try {
    const ctx = fakeCtx(root);
    const code = runReorder(['pkg'], ctx);
    assert.equal(code, 0);
    assert.equal(
      readFileSync(path.join(root, 'pkg', 'deep', 'c.js'), 'utf8'),
      'class C {\n  x = 0;\n\n  m() {}\n}\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
