import test from 'node:test';
import assert from 'node:assert';
import { analyze } from '../src/analyzer.js';
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

test('missing coverage file -> null coverage + null CRAP, with stderr warning', () => {
  const { root } = setupProject();
  const { metrics } = analyze({
    filePaths: [path.join(root, 'src', 'sample.js')],
    coveragePath: path.join(root, 'coverage', 'does-not-exist.json'),
    projectRoot: root,
  });
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].coverage, null);
  assert.equal(metrics[0].crapScore, null);
});

test('coverage path null -> null coverage + null CRAP', () => {
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
