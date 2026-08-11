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
