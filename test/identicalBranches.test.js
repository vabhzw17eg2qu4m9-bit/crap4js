import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  identicalBranchesViolations,
  identicalBranchesSummary,
  runIdenticalBranches,
} from '../src/identicalBranches.js';

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

function fixture(lines) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-identical-branches-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.js'), `${lines.join('\n')}\n`);
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function violationsOf(lines) {
  const root = fixture(lines);
  try {
    return identicalBranchesViolations(
      [path.join(root, 'src', 'a.js')],
      root,
    ).violations;
  } finally {
    cleanup(root);
  }
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

// Wrap statement lists in a function body so returns parse.
const fn = (body) => [`export function f(a, b, c, x, y) {`, ...body, `}`];

// --- Family 1+2: duplicate conditions and bodies in if/else-if chains -----

test('flags an exact duplicate condition in an else-if chain', () => {
  const v = violationsOf(fn([
    "if (a < 0) { return 'neg'; }",
    "else if (a == 0) { return 'zero'; }",
    "else if (a == 0) { return 'zero again'; }",
    "return 'other';",
  ]));
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 4);
  assert.match(v[0].message, /duplicate condition in if\/else-if chain/);
  assert.match(v[0].message, /'a == 0'/);
  assert.match(v[0].message, /same as line 3/);
});

test('two repeats of the same condition produce two violations', () => {
  const v = violationsOf(fn([
    "if (a == 0) { return 'a'; }",
    "else if (a == 0) { return 'b'; }",
    "else if (a == 0) { return 'c'; }",
    "return 'd';",
  ]));
  assert.deepEqual(v.map((x) => x.line), [3, 4]);
});

test('operand-reordered and regrouped duplicates still match', () => {
  // a == b matches b == a; (a && b) matches (b && a); || nests flatten
  // regardless of grouping — the canonical form sees one condition.
  const v = violationsOf(fn([
    'if (a == b && x) { return 1; }',
    'else if (x && (b == a)) { return 2; }',
    'return 3;',
  ]));
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 3);
  const flat = violationsOf(fn([
    'if ((a || b) && c) { return 1; }',
    'else if ((b || a) && c) { return 2; }',
    'return 3;',
  ]));
  assert.equal(flat.length, 1);
});

test('formatting, comments and parens do not hide a duplicate', () => {
  const v = violationsOf([
    'export function f(x) {',
    '  if (x == 0) { return 1; }',
    '  else if (x /* mid */ == 0) { return 2; }',
    '  return 3;',
    '}',
  ]);
  assert.equal(v.length, 1);
});

test('flags identical then-bodies; a block equals the naked statement', () => {
  const v = violationsOf(fn([
    "if (a) { return 'x'; }",
    'else if (b) return \'x\';',
    "return 'y';",
  ]));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /duplicate branch body/);
  assert.match(v[0].message, /same as line 2/);
  assert.equal(v[0].line, 3);
});

test('flags an else body equal to its then body', () => {
  const v = violationsOf(fn([
    "if (a) { return 'x'; }",
    "else { return 'x'; }",
    "return 'y';",
  ]));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /duplicate branch body/);
});

test('identical bodies in separate ifs are legal', () => {
  const v = violationsOf(fn([
    "if (a) { return 'x'; }",
    "if (b) { return 'x'; }",
    "return 'y';",
  ]));
  assert.deepEqual(v, []);
});

test('nested ifs are separate chains, an else-block if starts its own', () => {
  const legal = violationsOf(fn([
    "if (a == 0) { if (b == 0) { return 'origin'; } return 'x-zero'; }",
    "else if (b == 0) { return 'y-zero'; }",
    "return 'other';",
  ]));
  assert.deepEqual(legal, []);
  const v = violationsOf(fn([
    "if (a > 0) { return 'pos'; }",
    'else {',
    '  if (a == 0) { return 1; }',
    '  else if (a == 0) { return 2; }',
    '}',
    "return 'neg';",
  ]));
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 5);
});

// --- Family 3: duplicate and absorbed boolean-chain operands --------------

test('flags a repeated operand in || and && chains', () => {
  const or = violationsOf(['export const f = (a, b) => a || a || b;']);
  assert.equal(or.length, 1);
  assert.match(or[0].message, /duplicate operand in '\|\|' chain/);
  assert.match(or[0].message, /'a' repeats/);
  const and = violationsOf(['export const f = (a) => a && a;']);
  assert.equal(and.length, 1);
  assert.match(and[0].message, /duplicate operand in '&&' chain/);
});

test('flags a repeated call operand (double invocation)', () => {
  const v = violationsOf(['export const f = (ready) => ready() || ready();']);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /'ready\(\)' repeats/);
});

test('distinct operands are legal', () => {
  const v = violationsOf(['export const f = (a, b, c) => a || b || c;']);
  assert.deepEqual(v, []);
});

test('an absorbed operand is flagged, not flattened', () => {
  const v = violationsOf(['export const f = (a, b) => a && (b || a);']);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /absorption/);
  assert.match(v[0].message, /'a' also appears standalone/);
});

test('a nested different-operator chain without overlap is clean', () => {
  const v = violationsOf(['export const f = (a, b, c) => a && (b || c);']);
  assert.deepEqual(v, []);
});

test('reordered commutative operands still collapse', () => {
  const v = violationsOf(['export const f = (a, b) => (a && b) || (b && a);']);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /duplicate operand in '\|\|' chain/);
});

test('non-commutative operators are not reordered', () => {
  const v = violationsOf(fn([
    'if (a < b) { return 1; }',
    'else if (b < a) { return 2; }',
    'else if (a - b === 1) { return 3; }',
    'else if (b - a === 1) { return 4; }',
    'return 5;',
  ]));
  assert.deepEqual(v, []);
});

// --- Family 4: identical ternary branches ---------------------------------

test('flags identical ternary branches, including nested ones', () => {
  const v = violationsOf(['export const f = (c, x) => c ? x : x;']);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /identical then\/else branches/);
  assert.match(v[0].message, /the condition is dead/);
  const nested = violationsOf([
    'export const f = (c, d, x, y) => c ? (d ? x : y) : (d ? x : y);',
  ]);
  assert.equal(nested.length, 1);
});

test('different ternary branches are legal', () => {
  const v = violationsOf(['export const f = (c, x, y) => c ? x : y;']);
  assert.deepEqual(v, []);
});

// --- Family 5: duplicate positional call arguments ------------------------

test('flags a partial identifier repeat in one call', () => {
  const v = violationsOf(fn(['return measure(a, b, a);']));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /duplicate argument in call to 'measure'/);
  assert.match(v[0].message, /'a' \(same as argument 1\)/);
});

test('all-literal lists and lone literal repeats are exempt', () => {
  // Uniform-value API: everything literal, never flagged.
  assert.deepEqual(violationsOf(fn(['return rect(8, 8, 8, 4);'])), []);
  const v = violationsOf(fn(['return measure(a, 8, 8);']));
  // `8` repeats, but a literal is never the reported repeat — and `a`
  // is unique, so the list stays quiet.
  assert.deepEqual(v, []);
});

test('member calls flag under the property name; distinct args are legal', () => {
  const v = violationsOf(fn(['return builder.box(x, y, x);']));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /call to 'box'/);
  assert.deepEqual(violationsOf(fn(['return measure(a, b);'])), []);
});

test('spread arguments occupy no slot; options objects compare whole', () => {
  // Only one positional value besides the spread — nothing compares.
  assert.deepEqual(violationsOf(fn(['return tag(...xs, a);'])), []);
  // The options object is ONE argument (JS has no named arguments);
  // equal options objects in one call are a duplicate slot value.
  const v = violationsOf(fn(['return box(x, y, { width: w, height: h }, { width: w, height: h });']));
  assert.equal(v.length, 1);
});

// --- Family 6: duplicate catch/finally handler bodies ---------------------

test('flags a finally body identical to the catch body', () => {
  const v = violationsOf(fn([
    'try { run(); } catch (e) { log(e); } finally { log(e); }',
  ]));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /duplicate catch body in try statement/);
  assert.match(v[0].message, /same as line \d+/);
});

test('different handler bodies and a lone catch are legal', () => {
  const v = violationsOf(fn([
    'try { run(); } catch (e) { log(e); } finally { cleanup(); }',
  ]));
  assert.deepEqual(v, []);
  assert.deepEqual(violationsOf(fn([
    'try { run(); } catch (e) { log(e); }',
  ])), []);
});

// --- Scope, paths, summary -------------------------------------------------

test('conditions in different functions never compare', () => {
  const v = violationsOf([
    'export const a = (x) => x == 0;',
    'export const b = (x) => x == 0;',
  ]);
  assert.deepEqual(v, []);
});

test('violations carry file paths relative to the project root', () => {
  const root = fixture(fn([
    'if (a == 0) { return 1; }',
    'else if (a == 0) { return 2; }',
    'return 3;',
  ]));
  try {
    const result = identicalBranchesViolations(
      [path.join(root, 'src', 'a.js')],
      root,
    );
    assert.equal(result.violations[0].file, 'src/a.js');
    assert.equal(
      identicalBranchesSummary({
        violations: result.violations.length,
        checked: result.checked,
      }),
      '1 identical-branch finding(s) (1 constructs checked)',
    );
  } finally {
    cleanup(root);
  }
});

// --- Severity, flags, ignore wiring ----------------------------------------

test('warning severity reports violations and exits 0 by default', () => {
  const root = fixture(fn([
    'if (a == 0) { return 1; }',
    'else if (a == 0) { return 2; }',
    'return 3;',
  ]));
  try {
    const r = runCli(root, ['identical-branches']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /src\/a\.js:3: duplicate condition/);
    assert.match(r.stdout, /1 identical-branch finding\(s\)/);
  } finally {
    cleanup(root);
  }
});

test('--severity error makes violations exit 2', () => {
  const root = fixture(['export const f = (a) => a || a;']);
  try {
    const r = runCli(root, ['identical-branches', '--severity', 'error']);
    assert.equal(r.status, 2);
    const eq = runCli(root, ['identical-branches', '--severity=error']);
    assert.equal(eq.status, 2);
  } finally {
    cleanup(root);
  }
});

test('rejects unknown severity values and unknown flags', () => {
  const root = fixture(['export const f = (a) => a;']);
  try {
    const bad = runCli(root, ['identical-branches', '--severity', 'bogus']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--severity must be warning or error/);
    const flag = runCli(root, ['identical-branches', '--nope=x']);
    assert.equal(flag.status, 1);
    assert.match(flag.stderr, /unknown flag: --nope/);
  } finally {
    cleanup(root);
  }
});

test('ignore markers suppress findings', () => {
  const root = fixture([
    'export function f(a) {',
    '  if (a == 0) { return 1; } // ignore:identical-branches',
    '  else if (a == 0) { return 2; }',
    '  return 3;',
    '}',
  ]);
  try {
    const r = runCli(root, ['identical-branches', '--severity=error']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no identical-branch findings/);
  } finally {
    cleanup(root);
  }
});

test('passes on clean files and counts constructs', () => {
  const root = fixture([
    'export function f(a, b, c) {',
    '  if (a) { return 1; }',
    '  const t = b ? 2 : 3;',
    '  const u = b && c;',
    '  g(1, 2);',
    '  try { run(); } catch (e) { log(e); }',
    '  return 4;',
    '}',
  ]);
  try {
    const result = identicalBranchesViolations(
      [path.join(root, 'src', 'a.js')],
      root,
    );
    assert.deepEqual(result.violations, []);
    // Constructs: the if chain, the ternary, the && chain, the call, the try.
    assert.equal(result.checked, 5);
  } finally {
    cleanup(root);
  }
});

test('runIdenticalBranches returns 0 on warning findings via ctx', () => {
  const root = fixture(['export const f = (a) => a && a;']);
  try {
    const code = runIdenticalBranches([], fakeCtx(root));
    assert.equal(code, 0);
  } finally {
    cleanup(root);
  }
});
