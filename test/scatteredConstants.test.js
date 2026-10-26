import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseScatteredConstantsArgs,
  scatteredConstantsSummary,
  scatteredConstantsViolations,
  runScatteredConstants,
} from '../src/scatteredConstants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fakeCtx(cwd) {
  const out = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    lines: out,
  };
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-scattered-constants-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, 'src', name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function withFiles(files, fn) {
  const root = fixture(files);
  try {
    return fn(root, (name) => path.join(root, 'src', name));
  } finally {
    cleanup(root);
  }
}

// Scans the given src/ files with opts.
function scan(files, names, opts = {}) {
  return withFiles(files, (root, p) =>
    scatteredConstantsViolations(names.map(p), root, opts));
}

test('flags one violation per occurrence in min_files distinct files', () => {
  const r = scan(
    {
      'a.js': 'let x = 86400;\n',
      'b.js': 'let y = 86400;\n',
      'c.js': 'let z = 86400;\n',
    },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(r.violations.length, 3);
  for (const v of r.violations) {
    assert.notEqual(v.line, undefined);
    assert.match(v.message, /repeats in 3 files \(3 occurrences\)/);
    assert.match(v.message, /verify all occurrences mean the same thing first/);
  }
  assert.match(scatteredConstantsSummary({ ...r, violations: r.violations.length }), /scattered-literal/);
});

// Killing test: the core semantic is DISTINCT-FILE counting — in-file-only
// repeats stay invisible (that is magic-constants' job).
test('in-file-only repeats do not flag', () => {
  const r = scan(
    {
      'a.js': 'let x = 86400;\nlet y = 86400;\nlet z = 86400;\n',
      'b.js': 'let w = 86400;\n',
    },
    ['a.js', 'b.js'],
  );
  assert.equal(r.violations.length, 0);
  assert.match(
    scatteredConstantsSummary({ ...r, violations: r.violations.length }),
    /no literals repeat/,
  );
});

// Killing test: the min_files boundary — 2 files clean, 3 flagged.
test('min_files boundary: 2 files clean by default, 3rd file flags', () => {
  const files = {
    'a.js': 'let x = 86400;\n',
    'b.js': 'let y = 86400;\n',
  };
  assert.equal(scan(files, ['a.js', 'b.js']).violations.length, 0);
  assert.equal(
    scan({ ...files, 'c.js': 'let z = 86400;\n' }, ['a.js', 'b.js', 'c.js'])
      .violations.length,
    3,
  );
});

test('min_files is configurable, VALUE and =VALUE forms', () => {
  const files = {
    'a.js': "let x = 'shared-secret-value';\n",
    'b.js': "let y = 'shared-secret-value';\n",
  };
  const r = scan(files, ['a.js', 'b.js'], { minFiles: 2 });
  assert.equal(r.violations.length, 2);
  const parsed = parseScatteredConstantsArgs(['--min-files', '2', '--min-length=7']);
  assert.deepEqual(parsed, {
    minFiles: 2,
    minLength: 7,
    minValue: 100,
    ignore: [],
    exclude: [],
    paths: [],
  });
});

test('digit separators compare by value', () => {
  const r = scan(
    {
      'a.js': 'let x = 86400;\n',
      'b.js': 'let y = 86_400;\n',
      'c.js': 'let z = 86400;\n',
    },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(r.violations.length, 3);
});

test('a literal inside a const initializer counts with its file', () => {
  const r = scan(
    {
      'a.js': "const option = 'console-or-json-choice';\n",
      'b.js': "let x = 'console-or-json-choice';\n",
      'c.js': "let y = 'console-or-json-choice';\n",
    },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.ok(r.violations.length > 0);
});

test('a single hardcoded re-introduction flags immediately', () => {
  const r = scan(
    {
      'consts.js': 'const SECONDS_PER_DAY = 86400;\n',
      'other.js': 'let x = 86400;\n',
    },
    ['consts.js', 'other.js'],
  );
  assert.equal(r.violations.length, 1);
  assert.equal(path.basename(r.violations[0].file), 'other.js');
  assert.match(r.violations[0].message, /SECONDS_PER_DAY/);
  assert.match(r.violations[0].message, /consts\.js:1/);
  assert.match(r.violations[0].message, /duplicates constant/);
});

// Killing test: the declared constant's own literal is exempt — the
// blessed form never flags itself.
test('the constant declaration itself is never flagged', () => {
  const r = scan(
    { 'consts.js': 'const SECONDS_PER_DAY = 86400;\n' },
    ['consts.js'],
  );
  assert.equal(r.violations.length, 0);
});

test('string constants regress too', () => {
  const r = scan(
    {
      'consts.js': "const API_SCOPE = 'profile.read';\n",
      'ui.js': "let label = 'profile.read';\n",
    },
    ['consts.js', 'ui.js'],
  );
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].message, /API_SCOPE/);
});

test('hardcoded use in the declaring file still flags', () => {
  const r = scan(
    {
      'consts.js': 'const SECONDS_PER_DAY = 86400;\nlet also = 86400;\n',
    },
    ['consts.js'],
  );
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].line, 2);
});

test('duplicate local consts regress against the first declaration', () => {
  const r = scan(
    {
      'a.js': 'const SECONDS_PER_DAY = 86400;\n',
      'b.js': 'const DAY = 86400;\n',
      'c.js': 'const DAY_SECONDS = 86400;\n',
    },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(r.violations.length, 2);
  assert.equal(path.basename(r.violations[0].file), 'b.js');
  assert.match(r.violations[0].message, /SECONDS_PER_DAY/);
});

test('interpolated or computed constants do not register', () => {
  const r = scan(
    {
      'consts.js': "const SCOPE = 'profile' + '.read';\n",
      'ui.js': "let label = 'profile.read';\n",
    },
    ['consts.js', 'ui.js'],
  );
  assert.equal(r.violations.length, 0);
});

test('small numbers and short strings are coincidence', () => {
  const r = scan(
    {
      'a.js': "let a = 100;\nlet b = 'ok';\n",
      'b.js': "let a = 100;\nlet b = 'ok';\n",
      'c.js': "let a = 100;\nlet b = 'ok';\n",
    },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(r.violations.length, 0);
});

test('map keys and index expressions are protocol identifiers', () => {
  const r = scan(
    {
      'a.js': "const m = { 'session-key': 1 };\nlet x = m2['session-key'];\n",
      'b.js': "const m = { 'session-key': 2 };\nlet x = m2['session-key'];\n",
      'c.js': "const m = { 'session-key': 3 };\nlet x = m2['session-key'];\n",
    },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(r.violations.length, 0);
});

test('case labels are protocol identifiers', () => {
  const src = "switch (v) { case 'named-protocol-value': break; }\n";
  const r = scan({ 'a.js': src, 'b.js': src, 'c.js': src }, ['a.js', 'b.js', 'c.js']);
  assert.equal(r.violations.length, 0);
});

test('import and export specifiers are never flagged', () => {
  const a = "import { helper } from 'shared-library-name';\nexport { helper };\n";
  const b = "import { helper } from 'shared-library-name';\n";
  const c = "export { helper } from 'shared-library-name';\nexport * from 'shared-library-name';\n";
  const r = scan({ 'a.js': a, 'b.js': b, 'c.js': c }, ['a.js', 'b.js', 'c.js']);
  assert.equal(r.violations.length, 0);
});

test('double literals flag across min_files files', () => {
  const r = scan(
    {
      'a.js': 'let x = 86400.5;\n',
      'b.js': 'let y = 86400.5;\n',
      'c.js': 'let z = 86400.5;\n',
    },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(r.violations.length, 3);
  for (const v of r.violations) assert.match(v.message, /86400\.5/);
});

test('double literals at or below min_value are coincidence', () => {
  const r = scan(
    {
      'a.js': 'let x = 1.5;\n',
      'b.js': 'let y = 1.5;\n',
      'c.js': 'let z = 1.5;\n',
    },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(r.violations.length, 0);
});

test('double constants regress too', () => {
  const r = scan(
    {
      'consts.js': 'const RATE = 86400.5;\n',
      'other.js': 'let x = 86400.5;\n',
    },
    ['consts.js', 'other.js'],
  );
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].message, /RATE/);
});

test('excluded paths do not count towards the file total', () => {
  const r = scan(
    {
      'a.js': 'let x = 86400;\n',
      'b.js': 'let y = 86400;\n',
      'excluded/c.js': 'let z = 86400;\n',
    },
    ['a.js', 'b.js', 'excluded/c.js'],
    { exclude: ['src/excluded/**'] },
  );
  // test/** and generated files are already out via the shared default
  // selection; --exclude drops further files from the count entirely.
  assert.equal(r.violations.length, 0);
});

test('ignored string values never flag', () => {
  const r = scan(
    {
      'a.js': "let a = 'some-generic-word';\n",
      'b.js': "let a = 'some-generic-word';\n",
      'c.js': "let a = 'some-generic-word';\n",
    },
    ['a.js', 'b.js', 'c.js'],
    { ignore: ['some-generic-word'] },
  );
  assert.equal(r.violations.length, 0);
});

test('unlisted literals still flag alongside ignored ones', () => {
  const r = scan(
    {
      'a.js': "let a = 'some-generic-word';\nlet b = 'real-fact-value';\n",
      'b.js': "let a = 'some-generic-word';\nlet b = 'real-fact-value';\n",
      'c.js': "let a = 'some-generic-word';\nlet b = 'real-fact-value';\n",
    },
    ['a.js', 'b.js', 'c.js'],
    { ignore: ['some-generic-word'] },
  );
  assert.equal(r.violations.length, 3);
  for (const v of r.violations) assert.match(v.message, /'real-fact-value'/);
});

test('ignore matches numbers by decimal form', () => {
  const r = scan(
    {
      'a.js': 'let x = 86400;\n',
      'b.js': 'let y = 86400;\n',
      'c.js': 'let z = 86400;\n',
    },
    ['a.js', 'b.js', 'c.js'],
    { ignore: ['86400'] },
  );
  assert.equal(r.violations.length, 0);
});

test('entries with a slash are file-path globs, not values', () => {
  const r = scan(
    {
      'a.js': "let a = 'crypto-magic-constant';\n",
      'b.js': "let b = 'crypto-magic-constant';\n",
      'c.js': "let c = 'crypto-magic-constant';\n",
      'crypto/d.js': "let d = 'crypto-magic-constant';\n",
      'crypto/e.js': "let e = 'crypto-magic-constant';\n",
    },
    ['a.js', 'b.js', 'c.js', 'crypto/d.js', 'crypto/e.js'],
    { ignore: ['src/crypto/**'] },
  );
  assert.equal(r.violations.length, 3);
  for (const v of r.violations) assert.match(v.file, /^src\/[abc]\.js$/);
});

test('a plain word does not act as a folder glob', () => {
  const r = scan(
    {
      'a.js': "let a = 'some-fact';\n",
      'b.js': "let b = 'some-fact';\n",
      'excluded/c.js': "let c = 'some-fact';\n",
    },
    ['a.js', 'b.js', 'excluded/c.js'],
    { ignore: ['test'] },
  );
  // `test` silences the WORD, not a folder — all three occurrences report.
  assert.equal(r.violations.length, 3);
});

test('plain template literals count as strings, interpolations are skipped', () => {
  const r = scan(
    {
      'a.js': 'const GREETING = `plain-template-value`;\n',
      'b.js': 'let x = `plain-template-value`;\n',
      'c.js': 'let y = `interpolated-${x}-value`;\n',
    },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].line, 1);
  assert.match(scatteredConstantsSummary(r), /^1 hardcoded re-uses/);
});

test('summary distinguishes regressions from scattered occurrences', () => {
  assert.equal(
    scatteredConstantsSummary({ violations: 2, checked: 3, regressions: 2 }),
    '2 hardcoded re-uses of existing constants, 0 scattered-literal occurrences',
  );
  assert.equal(
    scatteredConstantsSummary({ violations: 0, checked: 3, regressions: 0 }),
    '3 files scanned, no literals repeat across files',
  );
});

test('const destructuring pattern defaults are ordinary sites', () => {
  // Pattern defaults live outside d.init — a re-introduction against a
  // registered const flags; plain initializer consts still register.
  const r = scan(
    {
      'consts.js': 'const SECONDS_PER_DAY = 86400;\n',
      'a.js': 'const { retry = 86400 } = opts;\n',
    },
    ['consts.js', 'a.js'],
  );
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].message, /SECONDS_PER_DAY/);
});

test('const pattern scatter across min_files files flags', () => {
  const src = 'const { timeout = 86400 } = opts;\n';
  assert.equal(
    scan({ 'a.js': src, 'b.js': src }, ['a.js', 'b.js']).violations.length,
    0,
  );
  const r = scan(
    { 'a.js': src, 'b.js': src, 'c.js': 'for (const [t = 86400] of xs) {}\n' },
    ['a.js', 'b.js', 'c.js'],
  );
  assert.equal(r.violations.length, 3);
  for (const v of r.violations) {
    assert.match(v.message, /repeats in 3 files \(3 occurrences\)/);
  }
});

test('command body: exit 2 with violations, 0 clean, invalid number exits 1', () => {
  withFiles(
    {
      'a.js': 'let x = 86400;\n',
      'b.js': 'let y = 86400;\n',
      'c.js': 'let z = 86400;\n',
    },
    (root, p) => {
      const ctx = fakeCtx(root);
      assert.equal(
        runScatteredConstants(['src/a.js', 'src/b.js', 'src/c.js'], ctx),
        2,
      );
      assert.match(ctx.lines.at(-1), /scattered-literal occurrences/);
      assert.equal(
        runScatteredConstants(['src/a.js', 'src/b.js', '--min-files=9'], ctx),
        0,
      );
      assert.throws(
        () => runScatteredConstants(['--min-files', 'x'], ctx),
        /Invalid --min-files/,
      );
    },
  );
});
