import test from 'node:test';
import assert from 'node:assert';
import { formatReport, padLeft, padRight } from '../src/report.js';

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

// --- mutation-survivor triage (upstream crap4dart 862acc1 practice) ---

function metric(name, file, startLine, crapScore) {
  return {
    methodName: name,
    file,
    startLine,
    complexity: 2,
    coverage: crapScore == null ? null : 1,
    crapScore,
  };
}

function dataRows(out, n) {
  return out.split('\n').slice(4, 4 + n).map((l) => l.trim().split(/\s+/)[0]);
}

test('threshold comparison is strict: a tie at the threshold passes', () => {
  assert.match(formatReport([metric('m', 'src/m.js', 1, 8.0)]),
    /Max CRAP: 8\.0 \(threshold 8\.0\) — passed/);
  assert.match(formatReport([metric('m', 'src/m.js', 1, 8.0)], { threshold: 8.0 }),
    /Max CRAP: 8\.0 \(threshold 8\.0\) — passed/);
  assert.match(formatReport([metric('m', 'src/m.js', 1, 8.0)], { threshold: 7.9 }),
    /Max CRAP: 8\.0 \(threshold 7\.9\) — FAILED/);
});

test('an explicit threshold below the 8.0 default is honored', () => {
  const out = formatReport([metric('m', 'src/m.js', 1, 6.0)], { threshold: 4.0 });
  assert.match(out, /Max CRAP: 6\.0 \(threshold 4\.0\) — FAILED/);
});

test('numeric rows precede N/A rows regardless of input order', () => {
  const na = metric('naRow', 'src/a.js', 3, null);
  const six = metric('sixRow', 'src/b.js', 1, 6.0);
  const two = metric('twoRow', 'src/c.js', 2, 2.0);
  for (const input of [[na, six, two], [six, na, two], [two, six, na]]) {
    assert.deepEqual(dataRows(formatReport(input), 3), ['sixRow', 'twoRow', 'naRow']);
  }
});

test('equal CRAP sorts by file then line, never by input order', () => {
  // Different files, equal CRAP: file order wins even from reversed input.
  assert.deepEqual(
    dataRows(formatReport([
      metric('inB', 'src/b.js', 1, 4.0),
      metric('inA', 'src/a.js', 1, 4.0),
    ]), 2),
    ['inA', 'inB'],
  );
  // Same file, equal CRAP: startLine order wins from reversed input.
  assert.deepEqual(
    dataRows(formatReport([
      metric('line2', 'src/x.js', 2, 4.0),
      metric('line1', 'src/x.js', 1, 4.0),
    ]), 2),
    ['line1', 'line2'],
  );
  // A falsy startLine counts as line 0, from either input position.
  const zero = metric('atZero', 'src/x.js', 0, 4.0);
  const one = metric('atOne', 'src/x.js', 1, 4.0);
  assert.deepEqual(dataRows(formatReport([one, zero]), 2), ['atZero', 'atOne']);
  assert.deepEqual(dataRows(formatReport([zero, one]), 2), ['atZero', 'atOne']);
});

test('padLeft/padRight pad exactly to the requested width', () => {
  assert.equal(padLeft('ab', 4), '  ab');
  assert.equal(padLeft('abc', 3), 'abc');
  assert.equal(padLeft('toolong', 3), 'toolong');
  assert.equal(padRight('ab', 4), 'ab  ');
  assert.equal(padRight('abc', 3), 'abc');
});
