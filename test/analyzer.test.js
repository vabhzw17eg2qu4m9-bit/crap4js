import test from 'node:test';
import assert from 'node:assert';
import { analyze, compareMetrics } from '../src/analyzer.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

function setupProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-analyzer-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'coverage'));
  const sourceFile = path.join(root, 'src', 'sample.js');
  writeFileSync(
    sourceFile,
    `export function addPositive(a, b) {
  if (a < 0) a = 0;
  return a + b;
}
`,
  );
  const coverage = {
    [sourceFile]: {
      statementMap: {
        '0': { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } },
        '1': { start: { line: 2, column: 2 }, end: { line: 2, column: 14 } },
        '2': { start: { line: 3, column: 2 }, end: { line: 3, column: 12 } },
      },
      s: { '0': 1, '1': 1, '2': 1 },
    },
  };
  writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), JSON.stringify(coverage));
  return { root, sourceFile };
}

test('analyze returns MethodMetric with all expected fields', () => {
  const { root } = setupProject();
  const { metrics } = analyze({
    filePaths: [path.join(root, 'src', 'sample.js')],
    coveragePath: path.join(root, 'coverage', 'coverage-final.json'),
    projectRoot: root,
  });
  assert.equal(metrics.length, 1);
  const m = metrics[0];
  assert.equal(m.methodName, 'addPositive');
  assert.equal(m.file, 'src/sample.js');
  assert.equal(m.complexity, 2);
  assert.equal(m.coverage, 1);
  // CC=2, coverage=1.0 -> 2^2 * 0^3 + 2 = 2.0
  assert.equal(m.crapScore, 2.0);
});

test('missing coverage file throws with the coverage-generation hint', () => {
  const { root } = setupProject();
  assert.throws(
    () =>
      analyze({
        filePaths: [path.join(root, 'src', 'sample.js')],
        coveragePath: path.join(root, 'coverage', 'does-not-exist.json'),
        projectRoot: root,
      }),
    (e) => {
      assert.match(e.message, /coverage file not found/);
      // The error names the port's own coverage generation command.
      assert.match(e.message, /npx c8 --reporter=json node --test/);
      return true;
    },
  );
});

test('zero-record coverage file throws by default', () => {
  const { root } = setupProject();
  writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), '{}');
  assert.throws(
    () =>
      analyze({
        filePaths: [path.join(root, 'src', 'sample.js')],
        coveragePath: path.join(root, 'coverage', 'coverage-final.json'),
        projectRoot: root,
      }),
    /coverage file has no records for this project/,
  );
});

test('coverage path null -> null coverage + null CRAP (profile inventory path)', () => {
  const { root } = setupProject();
  const { metrics } = analyze({
    filePaths: [path.join(root, 'src', 'sample.js')],
    coveragePath: null,
    projectRoot: root,
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].coverage, null);
  assert.equal(metrics[0].crapScore, null);
});

test('metrics sorted: numeric CRAP desc, nulls last', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-sort-'));
  mkdirSync(path.join(root, 'src'));
  const src = `
export function low() { if (true) return 1; return 0; }
export function high() { if (true) if (false) if (true) if (false) return 1; return 0; }
export function noCov() { return 1; }
`;
  writeFileSync(path.join(root, 'src', 'sample.js'), src);
  // coverage: only "low" hit, "high" partially hit, "noCov" has no statement in its range
  const f = path.join(root, 'src', 'sample.js');
  const coverage = {
    [f]: {
      statementMap: {
        '0': { start: { line: 2, column: 0 }, end: { line: 2, column: 50 } },
        '1': { start: { line: 3, column: 0 }, end: { line: 3, column: 70 } },
      },
      s: { '0': 1, '1': 0 },
    },
  };
  mkdirSync(path.join(root, 'coverage'));
  writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), JSON.stringify(coverage));

  const { metrics } = analyze({
    filePaths: [path.join(root, 'src', 'sample.js')],
    coveragePath: path.join(root, 'coverage', 'coverage-final.json'),
    projectRoot: root,
  });
  // high: CC=5, coverage=0 -> CRAP = 25 + 5 = 30.0
  // low: CC=2, coverage=1 -> CRAP = 2.0
  // noCov: no statement in range -> null
  const names = metrics.map((m) => m.methodName);
  assert.deepEqual(names, ['high', 'low', 'noCov']);
});

test('parse failures are collected and surfaced alongside metrics', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-parsefail-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'good.js'), 'export function ok() { return 1; }\n');
  // `}}}` throws even with errorRecovery — simulates a genuinely broken file.
  writeFileSync(path.join(root, 'src', 'broken.js'), '}}}\n');

  const { metrics, parseFailures } = analyze({
    filePaths: [
      path.join(root, 'src', 'good.js'),
      path.join(root, 'src', 'broken.js'),
    ],
    coveragePath: null,
    projectRoot: root,
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].methodName, 'ok');
  assert.deepEqual(parseFailures, ['src/broken.js']);
});

// --- mutation-survivor triage (upstream crap4dart 862acc1 practice) ---

function cm(file, startLine, crapScore) {
  return {
    methodName: `m_${file}_${startLine}`,
    file,
    startLine,
    complexity: 1,
    coverage: crapScore == null ? null : 1,
    crapScore,
  };
}

test('compareMetrics: numeric CRAP precedes N/A from either side', () => {
  const scored = cm('src/b.js', 1, 2.0);
  const na = cm('src/b.js', 2, null);
  assert.equal(compareMetrics(scored, na), -1);
  assert.equal(compareMetrics(na, scored), 1);
  // The N/A entry in the alphabetically earlier file: the null-vs-numeric
  // decision must not fall through to the file tie-break.
  const naFirst = cm('src/a.js', 1, null);
  const scoredLater = cm('src/b.js', 2, 2.0);
  assert.equal(compareMetrics(naFirst, scoredLater), 1);
  assert.equal(compareMetrics(scoredLater, naFirst), -1);
});

test('compareMetrics: equal CRAP tie-breaks by file, then startLine', () => {
  const fileA = cm('src/a.js', 1, 4.0);
  const fileB = cm('src/b.js', 9, 4.0);
  assert.equal(compareMetrics(fileA, fileB), -1);
  assert.equal(compareMetrics(fileB, fileA), 1);
  const line1 = cm('src/x.js', 1, 4.0);
  const line2 = cm('src/x.js', 2, 4.0);
  assert.equal(compareMetrics(line1, line2), -1);
  assert.equal(compareMetrics(line2, line1), 1);
});

// --- strict mode + diff-scoped selection (issue #79) ---

test('analyze strict throws on a missing coverage file', () => {
  const { root } = setupProject();
  assert.throws(
    () =>
      analyze({
        filePaths: [path.join(root, 'src', 'sample.js')],
        coveragePath: path.join(root, 'coverage', 'missing.json'),
        projectRoot: root,
        strict: true,
      }),
    /coverage file not found/,
  );
});

test('analyze strict scores files without a coverage entry as 0.0% covered', () => {
  const { root, sourceFile } = setupProject();
  const otherFile = path.join(root, 'src', 'other.js');
  writeFileSync(otherFile, 'export function tiny(a) {\n  return a;\n}\n');
  const { metrics } = analyze({
    filePaths: [sourceFile, otherFile],
    coveragePath: path.join(root, 'coverage', 'coverage-final.json'),
    projectRoot: root,
    strict: true,
  });
  const other = metrics.find((m) => m.file === 'src/other.js');
  // CC=1, coverage=0 -> 1^2 * 1^3 + 1 = 2.0 (computed, not N/A).
  assert.equal(other.coverage, 0);
  assert.equal(other.crapScore, 2.0);
  // The covered file is untouched by strict mode.
  assert.equal(metrics.find((m) => m.file === 'src/sample.js').coverage, 1);
});

test('analyze strict keeps N/A for statement-less functions in covered files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-analyzer-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'coverage'));
  const sourceFile = path.join(root, 'src', 'only.js');
  writeFileSync(sourceFile, 'export function real() {\n  return 1;\n}\nexport function hollow() {}\n');
  const coverage = {
    [sourceFile]: {
      statementMap: { '0': { start: { line: 2, column: 0 }, end: { line: 2, column: 12 } } },
      s: { '0': 1 },
    },
  };
  writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), JSON.stringify(coverage));
  const { metrics } = analyze({
    filePaths: [sourceFile],
    coveragePath: path.join(root, 'coverage', 'coverage-final.json'),
    projectRoot: root,
    strict: true,
  });
  assert.deepEqual(
    metrics.map((m) => [m.methodName, m.coverage]),
    [['real', 1], ['hollow', null]],
  );
});

test('analyze with diffLines reports only functions intersecting changed lines', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-analyzer-'));
  mkdirSync(path.join(root, 'src'));
  const sourceFile = path.join(root, 'src', 'two.js');
  writeFileSync(sourceFile, 'function first() {\n  return 1;\n}\nfunction second() {\n  return 2;\n}\n');
  const diff = new Map([['src/two.js', new Set([5])]]);
  const { metrics } = analyze({
    filePaths: [sourceFile],
    coveragePath: null,
    projectRoot: root,
    diffLines: diff,
  });
  assert.deepEqual(metrics.map((m) => m.methodName), ['second']);
});

test('analyze with diffLines drops files with no intersecting functions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-analyzer-'));
  mkdirSync(path.join(root, 'src'));
  const sourceFile = path.join(root, 'src', 'two.js');
  writeFileSync(sourceFile, 'function first() {\n  return 1;\n}\nfunction second() {\n  return 2;\n}\n');
  const diff = new Map([['src/two.js', new Set([99])]]);
  const { metrics, parseFailures } = analyze({
    filePaths: [sourceFile],
    coveragePath: null,
    projectRoot: root,
    diffLines: diff,
  });
  assert.deepEqual(metrics, []);
  assert.deepEqual(parseFailures, []);
});
