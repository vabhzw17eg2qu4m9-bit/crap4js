import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { coverageGateSummary, parseTestCoverageArgs, runTestCoverage } from '../src/testCoverage.js';
import { main } from '../src/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fakeCtx(cwd) {
  const out = [];
  const err = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    lines: out,
    errors: err,
  };
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-test-coverage-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// One single-line statement per entry: `{ line, hit }`.
function istanbulFile(root, rel, statements) {
  const statementMap = {};
  const s = {};
  statements.forEach(({ line, hit }, i) => {
    statementMap[String(i)] = { start: { line, column: 0 }, end: { line, column: 1 } };
    s[String(i)] = hit;
  });
  return [path.join(root, rel), { statementMap, s }];
}

function writeCoverage(root, entries, name = 'coverage-final.json') {
  mkdirSync(path.join(root, 'coverage'), { recursive: true });
  writeFileSync(path.join(root, 'coverage', name), JSON.stringify(Object.fromEntries(entries)));
}

test('coverage below the minimum fails with the dart-parity lines, exit 2', () => {
  const root = fixture({
    'a.js': 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n',
  });
  writeCoverage(root, [
    istanbulFile(root, 'src/a.js', [
      { line: 1, hit: 1 },
      { line: 2, hit: 1 },
      { line: 3, hit: 0 },
      { line: 4, hit: 0 },
    ]),
  ]);
  try {
    const ctx = fakeCtx(root);
    assert.equal(runTestCoverage([], ctx), 2);
    const printed = ctx.lines.join('');
    assert.match(printed, /^coverage\/coverage-final\.json: total coverage 50\.0% < min 80\.0%$/m);
    assert.match(printed, /^coverage 50\.0% < min 80\.0%$/m);
  } finally {
    cleanup(root);
  }
});

test('coverage at exactly the minimum passes (boundary, >=)', () => {
  const root = fixture({ 'a.js': 'a\nb\nc\nd\ne\n' });
  writeCoverage(root, [
    istanbulFile(root, 'src/a.js', [
      { line: 1, hit: 1 },
      { line: 2, hit: 1 },
      { line: 3, hit: 1 },
      { line: 4, hit: 1 },
      { line: 5, hit: 0 },
    ]),
  ]);
  try {
    const ctx = fakeCtx(root);
    assert.equal(runTestCoverage([], ctx), 0);
    assert.match(ctx.lines.join(''), /^coverage 80\.0% >= min 80\.0%$/m);
  } finally {
    cleanup(root);
  }
});

test('--min-percent overrides the default 80.0', () => {
  const root = fixture({ 'a.js': 'a\nb\n' });
  writeCoverage(root, [
    istanbulFile(root, 'src/a.js', [
      { line: 1, hit: 1 },
      { line: 2, hit: 0 },
    ]),
  ]);
  try {
    const failing = fakeCtx(root);
    assert.equal(runTestCoverage([], failing), 2);
    assert.match(failing.lines.join(''), /coverage 50\.0% < min 80\.0%/);
    assert.equal(runTestCoverage(['--min-percent', '50'], fakeCtx(root)), 0);
  } finally {
    cleanup(root);
  }
});

test('--flag=VALUE form is accepted', () => {
  const root = fixture({ 'a.js': 'a\n' });
  writeCoverage(root, [istanbulFile(root, 'src/a.js', [{ line: 1, hit: 1 }])]);
  try {
    assert.equal(runTestCoverage(['--min-percent=99.5'], fakeCtx(root)), 0);
    // Above 100% can never be reached: fails.
    const ctx = fakeCtx(root);
    assert.equal(runTestCoverage(['--min-percent=100.1'], ctx), 2);
    assert.match(ctx.lines.join(''), /coverage 100\.0% < min 100\.1%/);
  } finally {
    cleanup(root);
  }
});

test('an lcov .info tracefile is accepted via --coverage', () => {
  const root = fixture({ 'a.js': 'a\nb\n' });
  mkdirSync(path.join(root, 'coverage'), { recursive: true });
  writeFileSync(
    path.join(root, 'coverage', 'lcov.info'),
    ['SF:src/a.js', 'DA:1,1', 'DA:2,0', 'end_of_record', ''].join('\n'),
  );
  try {
    const ctx = fakeCtx(root);
    assert.equal(runTestCoverage(['--coverage', 'coverage/lcov.info'], ctx), 2);
    assert.match(ctx.lines.join(''), /total coverage 50\.0% < min 80\.0%/);
  } finally {
    cleanup(root);
  }
});

test('missing coverage input is an input error (exit 1), never a pass', () => {
  const root = fixture({ 'a.js': 'a\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(main(['test-coverage', '--coverage', 'coverage/absent.json'], ctx), 1);
    assert.match(ctx.errors.join(''), /no coverage data at coverage\/absent\.json/);
  } finally {
    cleanup(root);
  }
});

test('unparseable coverage input exits 1', () => {
  const root = fixture({ 'a.js': 'a\n' });
  mkdirSync(path.join(root, 'coverage'));
  writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), '{not json');
  try {
    const ctx = fakeCtx(root);
    assert.equal(main(['test-coverage'], ctx), 1);
    assert.match(ctx.errors.join(''), /no coverage data/);
  } finally {
    cleanup(root);
  }
});

test('record-free coverage input exits 1', () => {
  const root = fixture({ 'a.js': 'a\n' });
  writeCoverage(root, []);
  try {
    const ctx = fakeCtx(root);
    assert.equal(main(['test-coverage'], ctx), 1);
    assert.match(ctx.errors.join(''), /no coverage data/);
  } finally {
    cleanup(root);
  }
});

test('--exclude drops a file from the ratio', () => {
  const root = fixture({
    'good.js': 'a\nb\n',
    'bad.js': 'a\nb\n',
  });
  writeCoverage(root, [
    istanbulFile(root, 'src/good.js', [
      { line: 1, hit: 1 },
      { line: 2, hit: 1 },
    ]),
    istanbulFile(root, 'src/bad.js', [
      { line: 1, hit: 0 },
      { line: 2, hit: 0 },
    ]),
  ]);
  try {
    const withBoth = fakeCtx(root);
    assert.equal(runTestCoverage([], withBoth), 2);
    assert.match(withBoth.lines.join(''), /coverage 50\.0% < min 80\.0%/);
    const excluded = fakeCtx(root);
    assert.equal(runTestCoverage(['--exclude', '**/bad.js'], excluded), 0);
    assert.match(excluded.lines.join(''), /coverage 100\.0% >= min 80\.0%/);
  } finally {
    cleanup(root);
  }
});

test('selected files without a coverage entry are skipped, not counted as 0%', () => {
  const root = fixture({
    'covered.js': 'a\n',
    'never-run.js': 'a\n',
  });
  writeCoverage(root, [istanbulFile(root, 'src/covered.js', [{ line: 1, hit: 1 }])]);
  try {
    const ctx = fakeCtx(root);
    assert.equal(runTestCoverage([], ctx), 0);
    assert.match(ctx.lines.join(''), /coverage 100\.0% >= min 80\.0%/);
  } finally {
    cleanup(root);
  }
});

test('explicit path selection scopes the ratio', () => {
  const root = fixture({
    'good.js': 'a\n',
    'bad.js': 'a\n',
  });
  writeCoverage(root, [
    istanbulFile(root, 'src/good.js', [{ line: 1, hit: 1 }]),
    istanbulFile(root, 'src/bad.js', [{ line: 1, hit: 0 }]),
  ]);
  try {
    const ctx = fakeCtx(root);
    assert.equal(runTestCoverage([path.join(root, 'src', 'good.js')], ctx), 0);
    const ctx2 = fakeCtx(root);
    assert.equal(runTestCoverage([path.join(root, 'src', 'bad.js')], ctx2), 2);
  } finally {
    cleanup(root);
  }
});

test('empty selection reports nothing to check and exits 0', () => {
  const root = fixture({});
  try {
    const ctx = fakeCtx(root);
    assert.equal(runTestCoverage([], ctx), 0);
    assert.match(ctx.lines.join(''), /No source files to check\./);
  } finally {
    cleanup(root);
  }
});

test('parse: defaults and flags', () => {
  const opts = parseTestCoverageArgs([]);
  assert.equal(opts.minPercent, 80.0);
  assert.equal(opts.coverage, 'coverage/coverage-final.json');
  assert.deepEqual(opts.exclude, []);
  const flagged = parseTestCoverageArgs(['--min-percent', '90.5', '--coverage', 'c.info', '--exclude', 'a']);
  assert.equal(flagged.minPercent, 90.5);
  assert.equal(flagged.coverage, 'c.info');
  assert.deepEqual(flagged.exclude, ['a']);
});

test('coverageGateSummary lines', () => {
  assert.equal(coverageGateSummary({ violations: 0 }, 100), 'coverage 100.0% >= min 80.0%');
  assert.equal(coverageGateSummary({ violations: 1 }, 50), 'coverage 50.0% < min 80.0%');
  assert.equal(coverageGateSummary({ violations: 0 }, 90, 85), 'coverage 90.0% >= min 85.0%');
});
