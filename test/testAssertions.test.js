import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  runTestAssertions,
  testAssertionViolations,
  testAssertionsSummary,
} from '../src/testAssertions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function fakeCtx(cwd) {
  const out = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    lines: out,
  };
}

function fixture(files, testDir = 'test') {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-test-assertions-'));
  mkdirSync(path.join(root, testDir), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, testDir, name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function violationsOf(source) {
  const root = fixture({ 'a.test.js': source });
  try {
    return testAssertionViolations([path.join(root, 'test', 'a.test.js')], root).violations;
  } finally {
    cleanup(root);
  }
}

test('a test body with zero assertion calls is flagged', () => {
  const src = [
    "import test from 'node:test';",
    "test('does nothing', () => {",
    '  compute();',
    '});',
  ].join('\n');
  const v = violationsOf(src);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
  assert.match(v[0].message, /'does nothing' has 0 assertion\(s\)/);
  assert.match(v[0].message, /a test without assertions verifies nothing/);
});

test('assert calls through a default import count', () => {
  const src = [
    "import test from 'node:test';",
    "import assert from 'node:assert';",
    "test('direct call', () => assert(compute()));",
    "test('member call', () => assert.strictEqual(compute(), 1));",
  ].join('\n');
  assert.deepEqual(violationsOf(src), []);
});

test('destructured and namespace assert imports count', () => {
  const src = [
    "import { test } from 'node:test';",
    "import { ok, equal } from 'node:assert';",
    "import * as strict from 'node:assert/strict';",
    "test('destructured', () => ok(compute()));",
    "test('namespace', () => strict.equal(compute(), 1));",
    "test('both', () => {",
    '  ok(compute());',
    '  equal(compute(), 1);',
    '});',
  ].join('\n');
  assert.deepEqual(violationsOf(src), []);
});

test('t.assert calls on the test context count', () => {
  const src = [
    "import { it } from 'node:test';",
    "it('uses context', (t) => {",
    '  t.assert.equal(compute(), 1);',
    '});',
  ].join('\n');
  assert.deepEqual(violationsOf(src), []);
});

test('it(), test.skip and describe-nested tests are all checked', () => {
  const src = [
    "import { test, it, describe } from 'node:test';",
    "it('empty arrow', () => {});",
    "test.skip('skipped but still checked', () => {});",
    "describe('group', () => {",
    "  test('nested empty', () => {});",
    '});',
    'function compute() { return 1; }',
  ].join('\n');
  const v = violationsOf(src);
  assert.equal(v.length, 3);
  assert.deepEqual(v.map((x) => x.line), [2, 3, 5]);
});

test('assertions inside nested closures within the test body count', () => {
  const src = [
    "import test from 'node:test';",
    "import assert from 'node:assert';",
    "test('wraps', () => {",
    '  [1].forEach((n) => {',
    '    assert.ok(n);',
    '  });',
    '});',
  ].join('\n');
  assert.deepEqual(violationsOf(src), []);
});

test('clean file exits 0 with the passing summary', () => {
  const root = fixture({
    'ok.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert';",
      "test('ok', () => assert.ok(1));",
      '',
    ].join('\n'),
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runTestAssertions([], ctx), 0);
    assert.match(ctx.lines.join(''), /1 tests assert their expectations/);
  } finally {
    cleanup(root);
  }
});

test('violations print file:line and exit 2', () => {
  const root = fixture({
    'bad.test.js': [
      "import test from 'node:test';",
      "test('hollow', () => {});",
      '',
    ].join('\n'),
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runTestAssertions([], ctx), 2);
    assert.match(ctx.lines.join(''), /test\/bad\.test\.js:2: 'hollow' has 0 assertion\(s\)/);
    assert.match(ctx.lines.join(''), /1\/1 tests without assertions/);
  } finally {
    cleanup(root);
  }
});

test('colocated *.test.js files under src/ are checked by default', () => {
  const root = fixture({ 'spec.js': 'export const x = 1;\n' }, 'src');
  mkdirSync(path.join(root, 'test'), { recursive: true });
  writeFileSync(
    path.join(root, 'src', 'colocated.test.js'),
    "import test from 'node:test';\ntest('hollow', () => {});\n",
  );
  try {
    const ctx = fakeCtx(root);
    assert.equal(runTestAssertions([], ctx), 2);
    assert.match(ctx.lines.join(''), /src\/colocated\.test\.js:2/);
  } finally {
    cleanup(root);
  }
});

test('unknown flag is a usage error (exit 1)', () => {
  const root = fixture({});
  try {
    const ctx = fakeCtx(root);
    assert.throws(() => runTestAssertions(['--min', '2'], ctx), /unknown flag: --min/);
  } finally {
    cleanup(root);
  }
});

test('test-assertions over the repo itself finds no violations', () => {
  const ctx = fakeCtx(path.resolve(__dirname, '..'));
  assert.equal(runTestAssertions([], ctx), 0);
});

test('testAssertionsSummary lines', () => {
  assert.equal(testAssertionsSummary({ violations: 0, checked: 4 }), '4 tests assert their expectations');
  assert.equal(testAssertionsSummary({ violations: 2, checked: 5 }), '2/5 tests without assertions');
});

test('CLI dispatch: test-assertions exits 2 on a hollow test body', () => {
  const root = fixture({
    'bad.test.js': "import test from 'node:test';\ntest('hollow', () => {});\n",
  });
  try {
    const r = spawnSync(process.execPath, [CLI, 'test-assertions'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /1\/1 tests without assertions/);
  } finally {
    cleanup(root);
  }
});
