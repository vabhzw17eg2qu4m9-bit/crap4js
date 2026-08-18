import test from 'node:test';
import assert from 'node:assert';
import { formatReport } from '../src/report.js';

test('renders header, separator, rows, and summary', () => {
  const metrics = [
    {
      methodName: 'low',
      file: 'src/low.js',
      startLine: 1,
      complexity: 2,
      coverage: 1,
      crapScore: 2.0,
    },
    {
      methodName: 'high',
      file: 'src/high.js',
      startLine: 1,
      complexity: 5,
      coverage: 0,
      crapScore: 30.0,
    },
    {
      methodName: 'unknown',
      file: 'src/u.js',
      startLine: 1,
      complexity: 1,
      coverage: null,
      crapScore: null,
    },
  ];
  const out = formatReport(metrics, { threshold: 8.0 });
  const lines = out.split('\n');

  assert.equal(lines[0], 'CRAP Report');
  assert.equal(lines[1], '===========');
  assert.match(lines[2], /^Method\s+File\s+CC\s+Cov%\s+CRAP$/);
  assert.ok(lines[3].startsWith('-'.repeat(85)));

  // Sorted: numeric CRAP desc (high first, low second), null last.
  assert.match(lines[4], /^high\s+src\/high\.js\s+\d+\s+0\.0%\s+30\.0/);
  assert.match(lines[5], /^low\s+src\/low\.js\s+\d+\s+100\.0%\s+2\.0/);
  assert.match(lines[6], /^unknown\s+src\/u\.js\s+\d+\s+N\/A\s+N\/A/);

  // Blank line then summary.
  assert.equal(lines[7], '');
  assert.match(lines[8], /Max CRAP: 30\.0 \(threshold 8\.0\) — FAILED/);
});

test('all-N/A report: max 0.0, verdict passed', () => {
  const metrics = [
    {
      methodName: 'm',
      file: 'src/m.js',
      startLine: 1,
      complexity: 3,
      coverage: null,
      crapScore: null,
    },
  ];
  const out = formatReport(metrics, { threshold: 8.0 });
  assert.match(out, /Max CRAP: 0\.0 \(threshold 8\.0\) — passed/);
});

test('N/A rows tie-break by file then line for stable ordering (0.8.7)', () => {
  const mk = (methodName, file, startLine) => ({
    methodName,
    file,
    startLine,
    complexity: 1,
    coverage: null,
    crapScore: null,
  });
  // Deliberately unordered input — the table must not shuffle between runs.
  const out = formatReport(
    [mk('late', 'src/z.js', 9), mk('second', 'src/a.js', 5), mk('first', 'src/a.js', 2)],
    { threshold: 8.0 },
  );
  const rows = out.split('\n').filter((l) => /^(late|second|first)\s/.test(l));
  assert.deepEqual(
    rows.map((r) => r.trim().split(/\s+/)[0]),
    ['first', 'second', 'late'],
  );
});

test('passed verdict when max <= threshold', () => {
  const metrics = [
    {
      methodName: 'm',
      file: 'src/m.js',
      startLine: 1,
      complexity: 2,
      coverage: 1,
      crapScore: 2.0,
    },
  ];
  const out = formatReport(metrics, { threshold: 8.0 });
  assert.match(out, /Max CRAP: 2\.0 \(threshold 8\.0\) — passed/);
});

test('FAILED verdict when max > threshold', () => {
  const metrics = [
    {
      methodName: 'm',
      file: 'src/m.js',
      startLine: 1,
      complexity: 5,
      coverage: 0,
      crapScore: 30.0,
    },
  ];
  const out = formatReport(metrics, { threshold: 8.0 });
  assert.match(out, /Max CRAP: 30\.0 \(threshold 8\.0\) — FAILED/);
});

test('parse failures: summary line appended after Max CRAP when count > 0', () => {
  const metrics = [
    {
      methodName: 'm',
      file: 'src/m.js',
      startLine: 1,
      complexity: 2,
      coverage: 1,
      crapScore: 2.0,
    },
  ];
  const out = formatReport(metrics, {
    threshold: 8.0,
    parseFailures: ['src/a.js', 'src/b.js', 'src/c.js'],
  });
  const lines = out.split('\n');
  const maxIdx = lines.findIndex((l) => l.startsWith('Max CRAP:'));
  assert.ok(maxIdx >= 0);
  assert.match(lines[maxIdx + 1], /^Parse failures: 3 file\(s\) — see warnings above\./);
});

test('no parse-failure line when parseFailures omitted or empty', () => {
  const metrics = [
    {
      methodName: 'm',
      file: 'src/m.js',
      startLine: 1,
      complexity: 2,
      coverage: 1,
      crapScore: 2.0,
    },
  ];
  for (const opts of [{ threshold: 8.0 }, { threshold: 8.0, parseFailures: [] }]) {
    const out = formatReport(metrics, opts);
    assert.ok(!out.includes('Parse failures'));
  }
});
