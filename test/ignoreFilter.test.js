// Ignore-marker suppression tests, ported from crap4dart 8abb64c
// (test/gates/gate_ignore_rules_test.dart + gate_ignore_rules_file_test.dart
// + gate_ignore_test.dart), adapted to the crap4js violation model: the
// granular guarantee runs at the shared filter (filterIgnored), the wiring
// through the real magic-constants gate end to end.

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { filterIgnored, IGNORABLE_GATES } from '../src/ignoreFilter.js';
import { runCheck } from '../src/gateCommon.js';
import {
  magicConstantsSummary,
  magicConstantsViolations,
  runMagicConstants,
} from '../src/magicConstants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixtureDir(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), `crap4js-ignore-${prefix}-`));
  mkdirSync(path.join(root, 'src'));
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// Writes one source file into a temp project and returns the violations
// that survive filterIgnored for the gate.
function keptLines(source, gateId, violations) {
  const root = fixtureDir('unit');
  writeFileSync(path.join(root, 'src', 'a.js'), source);
  try {
    return filterIgnored(
      { violations, checked: 1 },
      gateId,
      root,
    ).violations.map((v) => v.line);
  } finally {
    cleanup(root);
  }
}

function violation(line) {
  return { file: 'src/a.js', line, message: 'x' };
}

// The granular guarantee: on one line, a marker silences only its own
// gate — the other two ignorable gates still fire (upstream's strongest
// test, three gates on the same line).
test('one marker on a three-violation line silences only its rule', () => {
  const source = 'x = 1; // ignore:magic-constants\n';
  const v = (message) => ({ file: 'src/a.js', line: 1, message });
  assert.deepEqual(keptLines(source, 'magic-constants', [v('magic')]), []);
  assert.deepEqual(keptLines(source, 'scattered-constants', [v('scattered')]), [1]);
  assert.deepEqual(keptLines(source, 'unused-code', [v('unused')]), [1]);
});

test('several single-id markers on one line union', () => {
  const source = 'x = 1; // ignore:magic-constants // ignore:scattered-constants\n';
  assert.deepEqual(keptLines(source, 'magic-constants', [violation(1)]), []);
  assert.deepEqual(keptLines(source, 'scattered-constants', [violation(1)]), []);
  assert.deepEqual(keptLines(source, 'unused-code', [violation(1)]), [1]);
});

test('stacked whole-line markers above all apply to the code line', () => {
  const source = '// ignore:magic-constants\n// ignore:scattered-constants\nx = 1;\n';
  const violations = [violation(3)];
  assert.deepEqual(keptLines(source, 'magic-constants', violations), []);
  assert.deepEqual(keptLines(source, 'scattered-constants', violations), []);
});

test('the stacked run stops at the first non-marker line', () => {
  const source = '// ignore:magic-constants\n\nx = 1;\n';
  assert.deepEqual(keptLines(source, 'magic-constants', [violation(3)]), [3]);
});

test('a trailing marker and one above both suppress', () => {
  const source = '// ignore-file:magic-constants\nx = 1; // ignore:scattered-constants\n';
  const violations = [violation(2)];
  assert.deepEqual(keptLines(source, 'magic-constants', violations), []);
  assert.deepEqual(keptLines(source, 'scattered-constants', violations), []);
});

test('a comma list is not a list — it names nothing', () => {
  const source = 'x = 1; // ignore:magic-constants,scattered-constants\n';
  assert.deepEqual(keptLines(source, 'magic-constants', [violation(1)]), [1]);
  assert.deepEqual(keptLines(source, 'scattered-constants', [violation(1)]), [1]);
});

test('an unknown gate id matches nothing', () => {
  const source = 'x = 1; // ignore:magic-constants-typo\n';
  assert.deepEqual(keptLines(source, 'magic-constants', [violation(1)]), [1]);
});

test('a bare ignore: suppresses every ignorable gate', () => {
  const source = 'x = 1; // ignore:\n';
  assert.deepEqual(keptLines(source, 'magic-constants', [violation(1)]), []);
  assert.deepEqual(keptLines(source, 'unused-code', [violation(1)]), []);
});

test('legacy crap:ignore keeps its blanket line scope', () => {
  assert.deepEqual(keptLines('x = 1; // crap:ignore\n', 'magic-constants', [violation(1)]), []);
  assert.deepEqual(keptLines('// crap:ignore\nx = 1;\n', 'unused-code', [violation(2)]), []);
  assert.deepEqual(keptLines('// other\n// crap:ignore\nx = 1;\n', 'unused-code', [violation(3)]), []);
});

test('ignore-file: suppresses the named gates file-wide within 5 lines', () => {
  const header = '// ignore-file:magic-constants\n// ignore-file:unused-code\n\n\n// filler\n';
  const source = `${header}x = 1;\n`;
  const violations = [violation(6)];
  assert.deepEqual(keptLines(source, 'magic-constants', violations), []);
  assert.deepEqual(keptLines(source, 'unused-code', violations), []);
  assert.deepEqual(keptLines(source, 'scattered-constants', violations), [6]);
});

test('an ignore-file: on line 6 is out of scope', () => {
  const source = '\n\n\n\n\n// ignore-file:magic-constants\nx = 1;\n';
  assert.deepEqual(keptLines(source, 'magic-constants', [violation(7)]), [7]);
});

test('several ignore-file markers union; a bare one is blanket', () => {
  const union = '// ignore-file:magic-constants\n// ignore-file:scattered-constants\n';
  assert.deepEqual(keptLines(`${union}x = 1;\n`, 'scattered-constants', [violation(3)]), []);
  const blanket = '// ignore-file:\n';
  assert.deepEqual(keptLines(`${blanket}x = 1;\n`, 'unused-code', [violation(2)]), []);
});

test('legacy crap:ignore-file keeps its blanket file scope', () => {
  assert.deepEqual(keptLines('// crap:ignore-file\nx = 1;\n', 'magic-constants', [violation(2)]), []);
});

test('violations without a line only heed file-scoped markers', () => {
  const root = fixtureDir('noline');
  const fileLevel = { file: 'src/a.js', message: 'x' };
  const run = (source) => {
    writeFileSync(path.join(root, 'src', 'a.js'), source);
    try {
      return filterIgnored({ violations: [fileLevel], checked: 1 }, 'magic-constants', root)
        .violations;
    } finally {
      rmSync(path.join(root, 'src', 'a.js'));
    }
  };
  try {
    assert.deepEqual(run('// ignore-file:magic-constants\nbody\n'), []);
    assert.deepEqual(run('// ignore:magic-constants\nbody\n'), [fileLevel]);
  } finally {
    cleanup(root);
  }
});

test('suppression never applies to a non-ignorable gate', () => {
  assert.equal(IGNORABLE_GATES.has('similarity'), false);
  assert.equal(IGNORABLE_GATES.has('mutation'), false);
  const blanket = 'x = 1; // crap:ignore\n';
  assert.deepEqual(keptLines(blanket, 'similarity', [violation(1)]), [1]);
  assert.deepEqual(keptLines(blanket, 'mutation', [violation(1)]), [1]);
  assert.deepEqual(keptLines('x = 1; // ignore:\n', 'profile', [violation(1)]), [1]);
});

test('unreadable files are never ignored', () => {
  const root = fixtureDir('missing');
  try {
    const result = filterIgnored(
      { violations: [{ file: 'src/gone.js', line: 1, message: 'x' }], checked: 1 },
      'magic-constants',
      root,
    );
    assert.deepEqual(result.violations.map((v) => v.line), [1]);
  } finally {
    cleanup(root);
  }
});

// Wiring through a real gate: the magic-constants subcommand end to end.
function runGate(source) {
  const root = fixtureDir('e2e');
  writeFileSync(path.join(root, 'src', 'a.js'), source);
  const out = [];
  const ctx = { cwd: root, out: { write: (s) => out.push(s) } };
  try {
    const code = runMagicConstants([], ctx);
    return { code, out };
  } finally {
    cleanup(root);
  }
}

test('magic-constants fires without a marker', () => {
  const { code, out } = runGate('el.style.color = 0x3366ff;\n');
  assert.equal(code, 2);
  assert.equal(out.filter((l) => l.includes('src/a.js:1')).length, 1);
});

test('a trailing ignore marker silences it', () => {
  const { code, out } = runGate('el.style.color = 0x3366ff; // ignore:magic-constants\n');
  assert.equal(code, 0);
  assert.deepEqual(out, ['1 files free of magic constants\n']);
});

test('the marker on the line above silences it', () => {
  const { code } = runGate('// ignore:magic-constants\nel.style.color = 0x3366ff;\n');
  assert.equal(code, 0);
});

test('a marker naming another gate does not silence it', () => {
  const { code, out } = runGate('el.style.color = 0x3366ff; // ignore:unused-code\n');
  assert.equal(code, 2);
  assert.equal(out.filter((l) => l.includes('src/a.js:1')).length, 1);
});

test('a file-scoped marker silences it', () => {
  const { code } = runGate('// ignore-file:magic-constants\nel.style.color = 0x3366ff;\n');
  assert.equal(code, 0);
});

test('legacy crap:ignore still silences it', () => {
  const { code } = runGate('el.style.color = 0x3366ff; // crap:ignore\n');
  assert.equal(code, 0);
});

test('runCheck leaves a non-ignorable gate untouched', () => {
  const root = fixtureDir('wiring');
  writeFileSync(path.join(root, 'src', 'a.js'), 'el.style.color = 0x3366ff; // crap:ignore\n');
  const out = [];
  const ctx = { cwd: root, out: { write: (s) => out.push(s) } };
  try {
    const code = runCheck(
      ctx,
      [path.join(root, 'src', 'a.js')],
      (files, projectRoot) => magicConstantsViolations(files, projectRoot),
      magicConstantsSummary,
      'similarity',
    );
    assert.equal(code, 2);
    assert.equal(out.filter((l) => l.includes('src/a.js:1')).length, 1);
  } finally {
    cleanup(root);
  }
});
