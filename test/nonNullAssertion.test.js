import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  nonNullAssertionViolations,
  nonNullAssertionSummary,
  runNonNullAssertion,
} from '../src/nonNullAssertion.js';

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

function fixture(lines, ext = 'js') {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-non-null-assertion-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', `a.${ext}`), `${lines.join('\n')}\n`);
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function resultOf(lines, ext) {
  const root = fixture(lines, ext);
  try {
    return nonNullAssertionViolations(
      [path.join(root, 'src', `a.${ext}`)],
      root,
    );
  } finally {
    cleanup(root);
  }
}

function violationsOf(lines, ext = 'ts') {
  return resultOf(lines, ext).violations;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

// --- Flagging: every bang is a finding ---------------------------------------

test('flags a postfix bang on a variable', () => {
  const v = violationsOf([
    'const s = o!.toString();',
    'print(s);',
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
  assert.match(v[0].message, /non-null assertion/);
  assert.match(v[0].message, /\?\./);
  assert.match(v[0].message, /\?\?/);
});

test('flags a bang on an index access', () => {
  const v = violationsOf(['const value = m["k"]!;']);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
});

test('flags every bang in a chain separately', () => {
  const v = violationsOf(['const len = a!.b!.c!.length;']);
  assert.equal(v.length, 3);
});

test('the violation carries the line of the ! token, not the operand', () => {
  const v = violationsOf([
    'const v = obj',
    '  .deep',
    '  .prop!;',
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 3);
});

test('flags bangs in .ts files', () => {
  const v = violationsOf(['const v = o!.p;'], 'ts');
  assert.equal(v.length, 1);
  assert.equal(v[0].file, 'src/a.ts');
});

test('flags bangs in .tsx files alongside JSX', () => {
  const v = violationsOf([
    'const el = <div onClick={() => q!.r()} />;',
    'const v = p!.q;',
  ], 'tsx');
  assert.equal(v.length, 2);
  assert.equal(v[0].file, 'src/a.tsx');
});

test('checked counts the scanned files', () => {
  const r = resultOf(['const v = o!.p;'], 'ts');
  assert.equal(r.checked, 1);
  assert.equal(r.violations.length, 1);
});

test('violations carry paths relative to the project root', () => {
  const root = fixture(['const v = o!.p;'], 'ts');
  try {
    const { violations } = nonNullAssertionViolations(
      [path.join(root, 'src', 'a.ts')],
      root,
    );
    assert.equal(violations[0].file, 'src/a.ts');
  } finally {
    cleanup(root);
  }
});

// --- Exclusions: distinct nodes, never flagged -------------------------------

test('does not flag the != and !== comparison operators', () => {
  const v = violationsOf([
    'const a = x != y;',
    'const b = x !== y;',
  ]);
  assert.equal(v.length, 0);
});

test('does not flag the logical-not prefix operator', () => {
  const v = violationsOf([
    'if (!flag) {',
    '  g();',
    '}',
  ]);
  assert.equal(v.length, 0);
});

test('does not flag increment and decrement operators', () => {
  const v = violationsOf([
    'let i = 0;',
    'const a = i++;',
    'const b = i--;',
    'const c = ++i;',
    'const d = --i;',
  ]);
  assert.equal(v.length, 0);
});

test('does not flag null-aware access or the ?? operator', () => {
  const v = violationsOf([
    'const a = o?.p;',
    'const b = o?.m() ?? fallback;',
    'o?.f();',
  ]);
  assert.equal(v.length, 0);
});

test('does not flag a bang inside a string literal', () => {
  const v = violationsOf([
    'const s = "wow!";',
    'const t = `bang! ${"hey!"}`;',
  ]);
  assert.equal(v.length, 0);
});

test('does not flag the as type assertion', () => {
  const v = violationsOf(['const v = expr as Shape;']);
  assert.equal(v.length, 0);
});

test('a .js file with logical-not never flags (plugin routing)', () => {
  const v = violationsOf([
    'const t = !flag;',
    'const a = x !== y;',
    'const b = i++;',
    'const c = o?.p ?? q;',
  ], 'js');
  assert.equal(v.length, 0);
  assert.equal(resultOf(['const t = !flag;'], 'js').violations.length, 0);
});

// --- Summary, severity, ignore wiring ----------------------------------------

test('summary strings match the contract', () => {
  assert.equal(
    nonNullAssertionSummary({ violations: 0, checked: 7 }),
    '7 files scanned, no non-null assertions',
  );
  assert.equal(
    nonNullAssertionSummary({ violations: 2, checked: 7 }),
    '2 non-null assertion(s) (7 files scanned)',
  );
});

test('warning severity reports violations and exits 0 by default', () => {
  const root = fixture(['const v = o!.p;'], 'ts');
  try {
    const r = runCli(root, ['non-null-assertion']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /non-null assertion/);
    assert.match(r.stdout, /a\.ts:1:/);
    assert.match(r.stdout, /1 non-null assertion/);
  } finally {
    cleanup(root);
  }
});

test('--severity error makes violations exit 2', () => {
  const root = fixture(['const v = o!.p;'], 'ts');
  try {
    const r = runCli(root, ['non-null-assertion', '--severity', 'error']);
    assert.equal(r.status, 2);
  } finally {
    cleanup(root);
  }
});

test('clean input exits 0 with the pass summary, even at error severity', () => {
  const root = fixture(['const a = o?.p ?? fallback;'], 'ts');
  try {
    for (const sev of [[], ['--severity', 'error']]) {
      const r = runCli(root, ['non-null-assertion', ...sev]);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /no non-null assertions/);
    }
  } finally {
    cleanup(root);
  }
});

test('rejects unknown severity values and unknown flags', () => {
  const root = fixture(['const v = o!.p;'], 'ts');
  try {
    assert.equal(
      runCli(root, ['non-null-assertion', '--severity', 'fatal']).status,
      1,
    );
    assert.equal(
      runCli(root, ['non-null-assertion', '--bang=1']).status,
      1,
    );
  } finally {
    cleanup(root);
  }
});

test('ignore markers suppress findings', () => {
  const root = fixture([
    'const v = o!.p;',
    '// ignore:non-null-assertion',
    'const w = o!.q;',
    'const x = o!.r; // crap:ignore',
  ], 'ts');
  try {
    // Only the unmarked first bang survives the filter.
    const r = runCli(root, ['non-null-assertion', '--severity=error']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /a\.ts:1: non-null assertion/);
    assert.equal(r.stdout.match(/: non-null assertion/g).length, 1);
  } finally {
    cleanup(root);
  }
});

test('the file-scoped ignore marker suppresses the whole file', () => {
  const root = fixture([
    '// ignore-file:non-null-assertion',
    'const v = o!.p;',
    'const w = o!.q;',
  ], 'ts');
  try {
    const r = runCli(root, ['non-null-assertion', '--severity=error']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no non-null assertions/);
  } finally {
    cleanup(root);
  }
});

test('runNonNullAssertion returns 0 on warning findings via ctx', () => {
  const root = fixture(['const v = o!.p;'], 'ts');
  try {
    const ctx = fakeCtx(root);
    const code = runNonNullAssertion([path.join('src', 'a.ts')], ctx);
    assert.equal(code, 0);
    assert.equal(
      ctx.lines.filter((l) => l.includes('non-null assertion')).length,
      2, // one violation line + the summary
    );
  } finally {
    cleanup(root);
  }
});
