import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  collapsibleFlowViolations,
  collapsibleFlowSummary,
  runCollapsibleFlow,
} from '../src/collapsibleFlow.js';

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
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-collapsible-flow-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.js'), `${lines.join('\n')}\n`);
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function resultOf(lines) {
  const root = fixture(lines);
  try {
    return collapsibleFlowViolations(
      [path.join(root, 'src', 'a.js')],
      root,
    );
  } finally {
    cleanup(root);
  }
}

function violationsOf(lines) {
  return resultOf(lines).violations;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

// Wrap statement lists in a function body so returns parse.
const fn = (body) => [`export function f(a, b, c, x, y) {`, ...body, `}`];

// --- Check 1: collapsible if ------------------------------------------------

test('flags a braced nested if with no else on either level', () => {
  const v = violationsOf(fn([
    '  if (a) {',
    '    if (b) {',
    '      g();',
    '    }',
    '  }',
  ]));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /merged into a single condition with `&&`/);
});

test('flags unbraced nesting on both levels', () => {
  const v = violationsOf(fn([
    '  if (a) if (b) g();',
  ]));
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
});

test('every collapsible level of a three-deep nest flags', () => {
  const v = violationsOf(fn([
    '  if (a) {',
    '    if (b) {',
    '      if (c) g();',
    '    }',
    '  }',
  ]));
  assert.equal(v.length, 2);
});

test('an inner else blocks the merge', () => {
  const v = violationsOf(fn([
    '  if (a) {',
    '    if (b) g(); else h();',
    '  }',
  ]));
  assert.equal(v.length, 0);
});

test('an outer else blocks the merge', () => {
  const v = violationsOf(fn([
    '  if (a) {',
    '    if (b) g();',
    '  } else {',
    '    h();',
    '  }',
  ]));
  assert.equal(v.length, 0);
});

test('extra statements beside the inner if block the merge', () => {
  const v = violationsOf(fn([
    '  if (a) {',
    '    setup();',
    '    if (b) g();',
    '  }',
    '  if (a) {',
    '    if (b) g();',
    '    teardown();',
    '  }',
  ]));
  assert.equal(v.length, 0);
});

test('a single non-if then-branch is not collapsible', () => {
  const v = violationsOf(fn([
    '  if (a) {',
    '    g();',
    '  }',
  ]));
  assert.equal(v.length, 0);
});

// --- Check 2: redundant else after an always-exiting then -------------------

test('flags a redundant else after a bare return', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    return 1;',
    '  } else {',
    '    g();',
    '  }',
  ]));
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
  assert.match(v[0].message, /redundant else after an always-exiting then branch/);
});

test('flags redundant else after throw, break and continue', () => {
  const v = violationsOf([
    'export function f(c, x, y) {',
    '  while (x) {',
    '    if (c === 1) { break; } else { g(); }',
    '    if (c === 2) { continue; } else { g(); }',
    '    if (c === 3) { throw new Error("x"); } else { g(); }',
    '  }',
    '}',
  ]);
  assert.equal(v.length, 3);
});

test('a block ending in an exit counts as exiting', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    setup();',
    '    return 1;',
    '  } else {',
    '    g();',
    '  }',
  ]));
  assert.equal(v.length, 1);
});

test('an if/else pair whose both branches exit counts as exiting', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    if (x) {',
    '      return 1;',
    '    } else {',
    '      return 2;',
    '    }',
    '  } else {',
    '    g();',
    '  }',
  ]));
  // The inner pair's own else is redundant (then returns), and the
  // outer then always exits, so the outer else is redundant too.
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => x.line), [2, 3]);
});

// --- The fall-through trap (upstream's hard-learned regression) -------------

test('an inner if WITHOUT else never makes the then branch exiting', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    if (x) return 1;',
    '  } else {',
    '    g();',
    '  }',
  ]));
  assert.equal(v.length, 0);
});

test('the fall-through trap also blocks the chain hint', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    if (x) return 1;',
    '  } else if (y) {',
    '    g();',
    '  }',
  ]));
  assert.equal(v.length, 0);
});

test('a trailing switch never counts as exiting (case fall-through)', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    switch (x) {',
    '      case 1:',
    '        return 1;',
    '      default:',
    '        return 2;',
    '    }',
    '  } else {',
    '    g();',
    '  }',
  ]));
  assert.equal(v.length, 0);
});

// --- Try shapes --------------------------------------------------------------

test('try with exiting body and no finally counts as exiting', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    try {',
    '      return 1;',
    '    } catch (e) {',
    '      g();',
    '    }',
    '  } else {',
    '    h();',
    '  }',
  ]));
  assert.equal(v.length, 1);
});

test('try with exiting body and an empty finally counts as exiting', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    try {',
    '      return 1;',
    '    } finally {',
    '    }',
    '  } else {',
    '    h();',
    '  }',
  ]));
  assert.equal(v.length, 1);
});

test('try with exiting body and an exiting finally counts as exiting', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    try {',
    '      return 1;',
    '    } finally {',
    '      cleanup();',
    '      throw new Error("boom");',
    '    }',
    '  } else {',
    '    h();',
    '  }',
  ]));
  assert.equal(v.length, 1);
});

test('a non-exiting body or a non-empty non-exiting finally blocks the flag', () => {
  const v = violationsOf(fn([
    '  if (c) {',
    '    try {',
    '      g();',
    '    } finally {',
    '    }',
    '  } else {',
    '    h();',
    '  }',
    '  if (c) {',
    '    try {',
    '      return 1;',
    '    } finally {',
    '      cleanup();',
    '    }',
    '  } else {',
    '    h();',
    '  }',
  ]));
  assert.equal(v.length, 0);
});

// --- Check 3: chain after terminal then (hint, no fix-shaped message) -------

test('an else-if after an exiting then is a hint at the else-if line', () => {
  const v = violationsOf(fn([
    '  if (c === 1) {',
    '    return 1;',
    '  } else if (c === 2) {',
    '    g();',
    '  }',
  ]));
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 4);
  assert.match(v[0].message, /else-if follows an always-exiting then branch/);
  assert.match(v[0].message, /guard clauses or a dispatch table/);
  // The rewrite is not mechanical — no fix-shaped message.
  assert.doesNotMatch(v[0].message, /dedent/);
});

// --- Counting, summary, paths ------------------------------------------------

test('checked counts every if statement including chain links', () => {
  const r = resultOf(fn([
    '  if (a) g();',
    '  if (b) g(); else if (c) g();',
  ]));
  assert.equal(r.checked, 3);
  assert.equal(r.violations.length, 0);
});

test('summary strings match the contract', () => {
  assert.equal(
    collapsibleFlowSummary({ violations: 0, checked: 7 }),
    '7 if statements checked, no collapsible flow',
  );
  assert.equal(
    collapsibleFlowSummary({ violations: 2, checked: 7 }),
    '2 collapsible-flow finding(s) (7 if statements checked)',
  );
});

test('violations carry paths relative to the project root', () => {
  const root = fixture(fn(['  if (a) { if (b) g(); }']));
  try {
    const { violations } = collapsibleFlowViolations(
      [path.join(root, 'src', 'a.js')],
      root,
    );
    assert.equal(violations[0].file, 'src/a.js');
  } finally {
    cleanup(root);
  }
});

// --- Severity, flags, ignore wiring ------------------------------------------

test('warning severity reports violations and exits 0 by default', () => {
  const root = fixture(fn([
    '  if (c) { return 1; } else { g(); }',
  ]));
  try {
    const r = runCli(root, ['collapsible-flow']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /redundant else/);
    assert.match(r.stdout, /1 collapsible-flow finding/);
  } finally {
    cleanup(root);
  }
});

test('--severity error makes violations exit 2', () => {
  const root = fixture(fn([
    '  if (c) { return 1; } else { g(); }',
  ]));
  try {
    const r = runCli(root, ['collapsible-flow', '--severity', 'error']);
    assert.equal(r.status, 2);
  } finally {
    cleanup(root);
  }
});

test('clean input exits 0 with the pass summary', () => {
  const root = fixture(fn([
    '  if (a) { g(); } else { h(); }',
  ]));
  try {
    const r = runCli(root, ['collapsible-flow']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no collapsible flow/);
  } finally {
    cleanup(root);
  }
});

test('rejects unknown severity values and unknown flags', () => {
  const root = fixture(fn(['  if (a) g();']));
  try {
    assert.equal(
      runCli(root, ['collapsible-flow', '--severity', 'fatal']).status,
      1,
    );
    assert.equal(runCli(root, ['collapsible-flow', '--cap=3']).status, 1);
  } finally {
    cleanup(root);
  }
});

test('ignore markers suppress findings', () => {
  const root = fixture(fn([
    '  if (c) { return 3; } else { g(); }',
    '  // ignore:collapsible-flow',
    '  if (c) { return 1; } else { g(); }',
    '  if (c) { return 2; } else { g(); } // crap:ignore',
  ]));
  try {
    // Only the unmarked first if survives the filter.
    const r = runCli(root, ['collapsible-flow', '--severity=error']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /a\.js:2: redundant else/);
    assert.equal(r.stdout.match(/redundant else/g).length, 1);
  } finally {
    cleanup(root);
  }
});

test('runCollapsibleFlow returns 0 on warning findings via ctx', () => {
  const root = fixture(fn([
    '  if (c) { return 1; } else { g(); }',
  ]));
  try {
    const ctx = fakeCtx(root);
    const code = runCollapsibleFlow([path.join('src', 'a.js')], ctx);
    assert.equal(code, 0);
    assert.equal(ctx.lines.filter((l) => l.includes('redundant else')).length, 1);
  } finally {
    cleanup(root);
  }
});
