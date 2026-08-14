import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  bannedImportViolations,
  bannedSummary,
  globToRegExp,
  parseRules,
  runBannedImports,
} from '../src/bannedImports.js';

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
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-banned-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    const p = path.join(root, 'src', ...name.split('/'));
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test('glob translation: * stays in-segment, ** crosses, ? is one char', () => {
  const g = (glob) => globToRegExp(glob);
  assert.ok(g('src/**/*.js').test('src/a/b.js'));
  assert.ok(g('src/**/*.js').test('src/b.js'));
  assert.ok(!g('src/*.js').test('src/a/b.js'));
  assert.ok(g('src/*.js').test('src/b.js'));
  assert.ok(g('**/test.js').test('test.js'));
  assert.ok(g('**/test.js').test('deep/nested/test.js'));
  assert.ok(g('a?c.js').test('abc.js'));
  assert.ok(!g('a?c.js').test('ac.js'));
  assert.ok(g('a.b.js').test('a.b.js'));
  assert.ok(!g('a.b.js').test('axb.js'));
});

test('parseRules zips --from/--forbid pairs in CLI order; message optional', () => {
  const { rules, paths } = parseRules([
    '--from', 'src/ui/**',
    '--forbid', 'src/db/**',
    '--message', 'UI must not import DB',
    '--from=lib/**', '--forbid=lodash',
    'src/',
  ]);
  assert.deepEqual(rules, [
    { from: 'src/ui/**', forbid: 'src/db/**', message: 'UI must not import DB' },
    { from: 'lib/**', forbid: 'lodash', message: null },
  ]);
  assert.deepEqual(paths, ['src/']);
});

test('parseRules rejects unbalanced pairs, extra messages, unknown flags, missing values', () => {
  assert.throws(() => parseRules(['--from', 'a']), /pairs/);
  assert.throws(() => parseRules(['--forbid', 'a']), /pairs/);
  assert.throws(() => parseRules(['--message', 'x']), /pairs/);
  assert.throws(() => parseRules(['--from', 'a', '--forbid', 'b', '--message', 'x', '--message', 'y']), /pairs/);
  assert.throws(() => parseRules(['--bogus=1']), /unknown flag/);
  assert.throws(() => parseRules(['--from']), /requires a value/);
});

test('imports matching a forbid glob are violations, with the message appended', () => {
  const root = fixture({
    'ui/button.js': "import { db } from 'src/db/pool';\nexport const b = db;\n",
    'ui/ok.js': "import { z } from 'zone.js';\nexport const o = z;\n",
  });
  try {
    const rules = [{ from: 'src/ui/**', forbid: 'src/db/**', message: 'UI must not import DB' }];
    const { violations, checked } = bannedImportViolations(
      [path.join(root, 'src', 'ui', 'button.js'), path.join(root, 'src', 'ui', 'ok.js')],
      root,
      rules,
    );
    assert.equal(checked, 2);
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /import src\/db\/pool is banned for src\/ui\/button\.js — UI must not import DB/);
  } finally {
    cleanup(root);
  }
});

test('relative imports are matched on their resolved project-relative path', () => {
  const root = fixture({
    'ui/list.js': "import { pool } from '../db/pool.js';\nexport const l = pool;\n",
    'db/pool.js': 'export const pool = 1;\n',
  });
  try {
    const rules = [{ from: 'src/ui/**', forbid: 'src/db/**', message: null }];
    const { violations } = bannedImportViolations(
      [path.join(root, 'src', 'ui', 'list.js'), path.join(root, 'src', 'db', 'pool.js')],
      root,
      rules,
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /import \.\.\/db\/pool\.js is banned for src\/ui\/list\.js$/);
  } finally {
    cleanup(root);
  }
});

test('files not matching any from glob are not checked', () => {
  const root = fixture({ 'db/pool.js': "import 'lodash';\nexport const pool = 1;\n" });
  try {
    const rules = [{ from: 'src/ui/**', forbid: 'lodash', message: null }];
    const { violations, checked } = bannedImportViolations(
      [path.join(root, 'src', 'db', 'pool.js')],
      root,
      rules,
    );
    assert.equal(checked, 0);
    assert.equal(violations.length, 0);
  } finally {
    cleanup(root);
  }
});

test('no rules prints "no rules configured" and passes', () => {
  const ctx = fakeCtx(REPO_ROOT);
  assert.equal(runBannedImports([], ctx), 0);
  assert.match(ctx.lines.join(''), /no rules configured/);
});

test('violations exit 2 with a summary; clean run exits 0', () => {
  const root = fixture({
    'ui/x.js': "import 'lodash';\nexport const x = 1;\n",
    'ui/y.js': "import 'zone.js';\nexport const y = 1;\n",
  });
  try {
    const bad = fakeCtx(root);
    const code = runBannedImports(
      ['--from', 'src/**', '--forbid', 'lodash', '--message', 'use ramda'],
      bad,
    );
    assert.equal(code, 2);
    assert.match(bad.lines.join(''), /src\/ui\/x\.js: import lodash is banned for src\/ui\/x\.js — use ramda/);
    assert.match(bad.lines.join(''), /1 banned import\(s\) in 2 files/);

    const good = fakeCtx(root);
    assert.equal(
      runBannedImports(['--from', 'src/**', '--forbid', 'nonexistent-pkg'], good),
      0,
    );
    assert.match(good.lines.join(''), /2 files comply with 1 rule\(s\)/);
  } finally {
    cleanup(root);
  }
});

test('usage errors surface as thrown errors (CLI maps them to exit 1)', () => {
  const ctx = fakeCtx(REPO_ROOT);
  assert.throws(() => runBannedImports(['--from', 'a', 'src/'], ctx), /pairs/);
});

test('bannedSummary lines', () => {
  assert.equal(
    bannedSummary({ violations: 0, checked: 3, ruleCount: 2 }),
    '3 files comply with 2 rule(s)',
  );
  assert.equal(
    bannedSummary({ violations: 2, checked: 3, ruleCount: 2 }),
    '2 banned import(s) in 3 files',
  );
});
