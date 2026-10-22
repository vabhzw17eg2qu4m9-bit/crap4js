import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  parseGcLine,
  reclaimedMb,
  heapDeltaMb,
  TapSpans,
  buildReport,
  parseMemoryArgs,
  collectTestFiles,
} from '../src/memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

// Real `node --trace-gc` rows (node v24 shapes). The first carries the
// `# ` prefix the test runner adds when forwarding a child row through
// its reporter stream; the last is a runner-process row.
const SCAVENGE_CHILD =
  '# [61089:0x7b680c000]       29 ms: Scavenge 37.6 (54.6) -> 34.3 (55.1) MB, pooled: 0 MB, 1.50 / 0.00 ms  (average mu = 1.000, current mu = 1.000) allocation failure; ';
const MARK_COMPACT_CHILD =
  '# [61089:0x7b680c000]      134 ms: Mark-Compact 353.1 (460.2) -> 4.8 (136.1) MB, pooled: 266 MB, 1.67 / 0.00 ms  (+ 0.4 ms in 26 steps since start of marking, biggest step 0.0 ms, walltime since start of marking 2 ms) (average mu = 0.871, current mu = 0.975) finalize incremental marking via task; GC in old space requested';
const SCAVENGE_RUNNER =
  '[61088:0xca640c000]       21 ms: Scavenge 5.6 (6.8) -> 5.1 (7.8) MB, pooled: 0 MB, 0.21 / 0.00 ms  (average mu = 1.000, current mu = 1.000) task; ';

function gc(pid, tsMs, before, after) {
  return { pid, tsMs, kind: 'Scavenge', usedBeforeMb: before, usedAfterMb: after, pauseMs: 1 };
}

// One TAP `ok` block: the `ok` line plus its YAML diagnostics, all
// arriving at `endMs` (one reporter flush).
function tapOk(name, num, durationMs, endMs, { indent = '', result = 'ok', type = 'test' } = {}) {
  const pad = indent ? indent + '  ' : '  ';
  return [
    [endMs, `${indent}${result} ${num} - ${name}`],
    [endMs, `${pad}---`],
    [endMs, `${pad}duration_ms: ${durationMs}`],
    [endMs, `${pad}type: '${type}'`],
    [endMs, `${pad}...`],
  ];
}

// Builds a run record from [wallMs, line] pairs — the same data the
// live capture sees: GC rows carry their live arrival (arrWallMs),
// TAP ok-lines arrive in one buffered burst at child exit.
function runFromLines(file, pairs, spawnWallMs, runnerPid) {
  const tap = new TapSpans();
  const gcs = [];
  for (const [t, line] of pairs) {
    const parsed = parseGcLine(line);
    if (parsed) gcs.push({ ...parsed, arrWallMs: t });
    tap.addLine(t, line);
  }
  tap.flush();
  return { file, spawnWallMs, runnerPid, gcs, spans: tap.spans };
}

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('parseGcLine reads a # -prefixed child scavenge row (PIN: exact numbers)', () => {
  const gcRow = parseGcLine(SCAVENGE_CHILD);
  assert.ok(gcRow);
  assert.equal(gcRow.pid, 61089);
  assert.equal(gcRow.tsMs, 29);
  assert.equal(gcRow.kind, 'Scavenge');
  assert.equal(gcRow.usedBeforeMb, 37.6);
  assert.equal(gcRow.usedAfterMb, 34.3);
  assert.ok(approx(reclaimedMb(gcRow), 3.3));
});

test('parseGcLine reads a Mark-Compact row with incremental-marking tail (PIN)', () => {
  const gcRow = parseGcLine(MARK_COMPACT_CHILD);
  assert.ok(gcRow);
  assert.equal(gcRow.kind, 'Mark-Compact');
  assert.equal(gcRow.tsMs, 134);
  assert.ok(approx(reclaimedMb(gcRow), 348.3));
});

test('parseGcLine rejects TAP events and test noise (KILL: loose row matcher)', () => {
  for (const line of [
    'TAP version 13',
    '# Subtest: allocates heavily',
    'ok 1 - allocates heavily',
    '    ok 2 - inner quick',
    'not ok 3 - failing test',
    '  duration_ms: 12.5',
    '1..2',
    '# tests 2',
    '# [not-a-gc-row] hello MB, pooled: 0 MB, 1 / 2 ms',
    '# [9:0xdeadbeef] 5 ms: Scavenge 1.0 (2.0) -> 0.5 (2.0) MB then trailing prose',
    'console.log from a test',
    '',
  ]) {
    assert.equal(parseGcLine(line), null, `noise parsed as GC: ${line}`);
  }
});

test('reclaimedMb clamps at 0 and heapDeltaMb keeps the sign (KILL: unclamped churn)', () => {
  const growing = gc(1, 10, 5.0, 6.5);
  assert.equal(reclaimedMb(growing), 0);
  assert.equal(heapDeltaMb(growing), 1.5);
  const shrinking = gc(1, 20, 6.5, 2.0);
  assert.equal(reclaimedMb(shrinking), 4.5);
  assert.equal(heapDeltaMb(shrinking), -4.5);
});

test('parseGcLine reads both %p pointer renderings and indented forwarded rows (PIN: Windows shapes)', () => {
  // V8 prints the isolate header as `[%d:%p]` (gc-tracer.cc). The MSVC
  // CRT renders %p as bare uppercase hex — Linux/macOS as 0x + lowercase.
  const msvc = parseGcLine('[61089:00000267D0F1A000]       29 ms: Scavenge 37.6 (54.6) -> 34.3 (55.1) MB, pooled: 0 MB, 1.50 / 0.00 ms  (average mu = 1.000, current mu = 1.000) allocation failure; ');
  assert.ok(msvc, 'MSVC %p row must parse');
  assert.equal(msvc.tsMs, 29);
  assert.ok(approx(reclaimedMb(msvc), 3.3));
  const indented = parseGcLine('    # [61089:00000267D0F1A000]       29 ms: Scavenge 4.0 (5.0) -> 0.5 (5.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure; ');
  assert.ok(indented, 'indented forwarded row must parse');
  assert.equal(indented.usedAfterMb, 0.5);
});

test('rows stamped with the runner pid still report when nothing else remains (process-boundary insurance)', () => {
  const run = runFromLines(
    path.join('test', 'inline.test.js'),
    [
      ...tapOk('only test', 1, 10, 600),
      [600, '# [99:0xabc]     500 ms: Scavenge 2.0 (3.0) -> 1.0 (3.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure; '],
    ],
    100,
    99,
  );
  const report = buildReport([run], '.');
  assert.equal(report.gcCount, 1);
  assert.equal(report.totalChurnMb, 1);
  assert.equal(report.tests[0].gcs, 1);
});

test('TapSpans builds spans from ok blocks and separates suites from tests', () => {
  const tap = new TapSpans();
  for (const [t, line] of [
    ...tapOk('outer suite', 1, 900, 2000, { type: 'suite' }),
    ...tapOk('inner quick', 1, 50, 1200, { indent: '    ' }),
    ...tapOk('failing test', 2, 10, 1500, { indent: '    ', result: 'not ok' }),
  ]) {
    tap.addLine(t, line);
  }
  tap.flush();
  assert.deepEqual(
    tap.spans.map((s) => [s.name, s.type, s.result, s.startMs, s.endMs]),
    [
      ['outer suite', 'suite', 'pass', 1100, 2000],
      ['inner quick', 'test', 'pass', 1150, 1200],
      ['failing test', 'test', 'fail', 1490, 1500],
    ],
  );
});

test('TapSpans ignores GC rows and TAP noise', () => {
  const tap = new TapSpans();
  tap.addLine(10, SCAVENGE_CHILD);
  tap.addLine(10, 'TAP version 13');
  tap.addLine(10, '# Subtest: x');
  tap.addLine(10, '1..2');
  tap.addLine(10, '# tests 2');
  assert.equal(tap.spans.length, 0);
  assert.equal(tap.pending, null);
});

test('TapSpans flush keeps a stream cut before diagnostics as a zero-width span', () => {
  const tap = new TapSpans();
  tap.addLine(500, 'ok 1 - cut short');
  tap.flush();
  assert.deepEqual(tap.spans, [
    { name: 'cut short', type: 'test', result: 'pass', startMs: 500, endMs: 500 },
  ]);
});

// Clock layout (heavy file): spawn 1000, child clock zero 1050 (its
// first row's arrival 1100 − ts 50). The test (dur 40) ends just before
// child exit: the TAP burst arrives at 1200 → tiled window [1160,
// 1200]. Rows: loading ts 50 (row wall 1100 — before the window →
// bucket), in-test ts 120 (wall 1170 — inside). The runner row (pid
// 61088) is a runner-process row → bucket. Light file: spawn 5000, zero
// 5040 (arrival 5940 − ts 900), burst 6050 → window [5850, 6050]; its
// GC (row wall 5940) is inside. Every attribution is exact under the
// per-child clock — no offset vote exists anymore.
//
// Labels: fixtures use relative file paths with a '.' root so
// path.relative round-trips on every platform ('\'' vs '/').
const LABEL_HEAVY = path.join('test', 'heavy.test.js');
const LABEL_LIGHT = path.join('test', 'light.test.js');
const LABEL_NESTED = path.join('test', 'nested.test.js');

function twoFileRuns() {
  const heavy = runFromLines(
    LABEL_HEAVY,
    [
      [1200, 'TAP version 13'],
      ...tapOk('allocates a lot', 1, 40, 1200),
      [1100, `# [101:0xa]      50 ms: Scavenge 5.0 (6.0) -> 4.5 (6.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) task; `],
      [1170, `# [101:0xa]     120 ms: Scavenge 9.0 (10.0) -> 5.0 (10.0) MB, pooled: 0 MB, 1.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure; `],
      [1195, SCAVENGE_RUNNER],
    ],
    1000,
    61088,
  );
  const light = runFromLines(
    LABEL_LIGHT,
    [
      [6050, 'TAP version 13'],
      ...tapOk('quiet test', 1, 200, 6050),
      [5940, `# [102:0xb]     900 ms: Scavenge 3.0 (4.0) -> 1.0 (4.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure; `],
    ],
    5000,
    61089,
  );
  return [heavy, light];
}

test('attributes GCs to their own file and test; loading/runner rows are unattributed (KILL: window boundary, pid rules)', () => {
  const report = buildReport(twoFileRuns(), '.');
  // All 4 parsed rows counted (2 heavy child + 1 runner + 1 light child).
  assert.equal(report.gcCount, 4);
  assert.equal(report.unattributedCount, 2);
  assert.equal(report.testCount, 2);
  const byLabel = Object.fromEntries(report.suites.map((s) => [s.label, s]));
  // File totals carry ONLY window rows: heavy just the in-test 4.0
  // (loading 0.5 went to the bucket), light 2.0.
  assert.deepEqual(byLabel[LABEL_HEAVY], { label: LABEL_HEAVY, gcs: 1, churnMb: 4, growthMb: -4 });
  assert.deepEqual(byLabel[LABEL_LIGHT], { label: LABEL_LIGHT, gcs: 1, churnMb: 2, growthMb: -2 });
  // Bucket: the heavy loading row (0.5) + the runner row (0.5).
  assert.equal(report.unattributedChurnMb, 1);
  const heavyTest = report.tests.find((t) => t.label === 'allocates a lot');
  assert.deepEqual(heavyTest, {
    label: 'allocates a lot', suite: LABEL_HEAVY, type: 'test', result: 'pass',
    gcs: 1, churnMb: 4, growthMb: -4,
  });
  const lightTest = report.tests.find((t) => t.label === 'quiet test');
  assert.deepEqual(lightTest, {
    label: 'quiet test', suite: LABEL_LIGHT, type: 'test', result: 'pass',
    gcs: 1, churnMb: 2, growthMb: -2,
  });
  // Totals span every row (window + bucket): 4 + 2 in-window, 0.5
  // loading + 0.5 runner in the bucket.
  assert.equal(report.totalChurnMb, 7);
  assert.equal(report.totalHeapGrowthMb, -7);
});

test('rows on or outside window edges never leak into file totals (KILL: bucket boundary)', () => {
  // One file, two sequential tests (dur 100 each), TAP burst at 1400 →
  // tiled windows [1200, 1300] and [1300, 1400]; the file's first row
  // anchors the child clock at zero 1000 (arrival − ts). Rows: 1 ms
  // before the first window start and 1 ms after the last window end —
  // both bucket; rows exactly ON a window edge stay in the file
  // (inclusive on both edges).
  const run = runFromLines(
    LABEL_HEAVY,
    [
      ...tapOk('first', 1, 100, 1400),
      ...tapOk('second', 2, 100, 1400),
      [1199, `# [101:0xa]     199 ms: Scavenge 2.0 (3.0) -> 1.0 (3.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) task; `],
      [1200, `# [101:0xa]     200 ms: Scavenge 2.0 (3.0) -> 1.0 (3.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) task; `],
      [1250, `# [101:0xa]     250 ms: Scavenge 2.0 (3.0) -> 1.0 (3.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) task; `],
      [1350, `# [101:0xa]     350 ms: Scavenge 2.0 (3.0) -> 1.0 (3.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) task; `],
      [1400, `# [101:0xa]     400 ms: Scavenge 2.0 (3.0) -> 1.0 (3.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) task; `],
      [1401, `# [101:0xa]     401 ms: Scavenge 2.0 (3.0) -> 1.0 (3.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) task; `],
    ],
    1000,
    61088,
  );
  const report = buildReport([run], '.');
  const suite = report.suites[0];
  // Only the four in-window rows are attributed.
  assert.equal(suite.gcs, 4);
  assert.equal(suite.churnMb, 4);
  assert.equal(report.unattributedCount, 2);
  assert.equal(report.unattributedChurnMb, 2);
  assert.equal(report.totalChurnMb, 6);
  const first = report.tests.find((t) => t.label === 'first');
  const second = report.tests.find((t) => t.label === 'second');
  assert.equal(first.gcs, 2);
  assert.equal(second.gcs, 2);
});

test('a GC during describe-nested execution lands on the enclosing suite span (PIN: flat tiling)', () => {
  // Wall layout: the inner test completes first (ok at 1200, dur 50),
  // the enclosing suite at the burst (2000, dur 900). Windows tile back
  // from the burst: suite [1100, 2000], inner [1050, 1100] — flat, so
  // the GC executed inside the nested test (child clock 170 → wall
  // 1170 under zero 1000) lands on the ENCLOSING suite span. It still
  // counts toward the file total; only the per-test label is coarse.
  const nested = runFromLines(
    LABEL_NESTED,
    [
      ...tapOk('outer suite', 1, 900, 2000, { type: 'suite' }),
      ...tapOk('inner quick', 1, 50, 1200, { indent: '    ' }),
      [1170, `# [103:0xc]     170 ms: Scavenge 4.0 (5.0) -> 0.7 (5.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure; `],
      [2000, `# [103:0xc]    1000 ms: Scavenge 2.0 (3.0) -> 1.0 (3.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) task; `],
    ],
    1000,
    61088,
  );
  const report = buildReport([nested], '.');
  assert.equal(report.testCount, 1); // suite spans are not tests
  const inner = report.tests.find((t) => t.label === 'inner quick');
  assert.equal(inner.gcs, 0);
  // Both rows land on the enclosing suite span (the anchor GC at the
  // window's end edge, inclusive).
  const outer = report.tests.find((t) => t.label === 'outer suite');
  assert.equal(outer.gcs, 2);
  assert.equal(outer.churnMb, 4.3);
  const suite = report.suites[0];
  assert.equal(suite.gcs, 2);
  assert.equal(suite.churnMb, 4.3);
  assert.equal(report.unattributedCount, 0);
});

test('rows of a run with no TAP spans are all unattributed (covers the zero fallback)', () => {
  const run = runFromLines(
    LABEL_HEAVY,
    [
      [1500, `# [101:0xa]     100 ms: Scavenge 2.0 (3.0) -> 1.0 (3.0) MB, pooled: 0 MB, 0.5 / 0.0 ms  (average mu = 1.000, current mu = 1.000) task; `],
    ],
    1000,
    61088,
  );
  const report = buildReport([run], '.');
  assert.equal(report.suites[0].gcs, 0);
  assert.equal(report.gcCount, 1);
  assert.equal(report.unattributedCount, 1);
  assert.equal(report.unattributedChurnMb, 1);
  assert.equal(report.testCount, 0);
});

test('parseMemoryArgs defaults, parses and validates (KILL: missing validation)', () => {
  assert.deepEqual(parseMemoryArgs([]), {
    top: 20, format: 'console', badge: null, badgeThreshold: 500, paths: [],
  });
  assert.deepEqual(parseMemoryArgs(['--top', '5', '--format', 'json', 'test/a.test.js']),
    { top: 5, format: 'json', badge: null, badgeThreshold: 500, paths: ['test/a.test.js'] });
  assert.deepEqual(parseMemoryArgs(['--top=7']), { top: 7, format: 'console', badge: null, badgeThreshold: 500, paths: [] });
  assert.deepEqual(
    parseMemoryArgs(['--badge', 'badges/memory.svg', '--badge-threshold', '1000']),
    { top: 20, format: 'console', badge: 'badges/memory.svg', badgeThreshold: 1000, paths: [] },
  );
  assert.throws(() => parseMemoryArgs(['--format', 'yaml']), /Invalid --format/);
  assert.throws(() => parseMemoryArgs(['--top', '0']), /Invalid --top/);
  assert.throws(() => parseMemoryArgs(['--top', 'abc']), /Invalid --top/);
  assert.throws(() => parseMemoryArgs(['--badge-threshold', '-1']), /Invalid --badge-threshold/);
  assert.throws(() => parseMemoryArgs(['--badge-threshold', 'lots']), /Invalid --badge-threshold/);
  assert.throws(() => parseMemoryArgs(['--bogus']), /unknown flag/);
});

test('collectTestFiles expands directories to js test files and rejects missing paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-memory-files-'));
  try {
    mkdirSync(path.join(root, 'test', 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'test', 'a.test.js'), '');
    writeFileSync(path.join(root, 'test', 'b.mjs'), '');
    writeFileSync(path.join(root, 'test', 'sub', 'c.js'), '');
    writeFileSync(path.join(root, 'test', 'README.md'), '');
    assert.deepEqual(collectTestFiles(['test'], root), [
      path.join(root, 'test', 'a.test.js'),
      path.join(root, 'test', 'b.mjs'),
      path.join(root, 'test', 'sub', 'c.js'),
    ]);
    assert.deepEqual(collectTestFiles(['test/a.test.js'], root), [path.join(root, 'test', 'a.test.js')]);
    assert.throws(() => collectTestFiles(['nope'], root), /no such path: nope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- 8< -- CLI integration: the real command against a real fixture suite.

function buildFixtureProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-memory-fixture-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(path.join(root, 'test'));
  writeFileSync(
    path.join(root, 'test', 'one.test.js'),
    `import test from 'node:test';
test('allocates a lot', () => {
  let sink = [];
  for (let i = 0; i < 1_500_000; i++) sink.push({ i });
  if (sink.length !== 1_500_000) throw new Error('nope');
});
`,
  );
  writeFileSync(
    path.join(root, 'test', 'two.test.js'),
    `import test from 'node:test';
test('quiet test', () => { if (1 + 1 !== 2) throw new Error('nope'); });
`,
  );
  return root;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

test('memory reports the fixture suite on stdout and progress on stderr', () => {
  const root = buildFixtureProject();
  try {
    const r = runCli(root, ['memory', '--top', '2']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /running 2 test file\(s\) under node --trace-gc/);
    assert.match(r.stdout, /memory: 2 tests, \d+ GCs, churn [\d.]+ MB reclaimed/);
    assert.match(r.stdout, /top 2 by allocation churn/);
    assert.match(r.stdout, /top 2 by heap growth/);
    // A real allocation churn number came out of a real run.
    const churn = Number(r.stdout.match(/churn ([\d.]+) MB/)[1]);
    assert.ok(churn > 0, `expected real churn, got ${churn}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test('memory --format json keeps stdout JSON-only', () => {
  const root = buildFixtureProject();
  try {
    const r = runCli(root, ['memory', '--format', 'json']);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout); // throws if anything else leaked
    assert.equal(report.testCount, 2);
    assert.equal(report.suites.length, 2);
    assert.equal(report.tests.length, 2);
    assert.ok(Number.isFinite(report.totalChurnMb));
    assert.ok(Number.isInteger(report.unattributedCount));
    assert.ok(Number.isFinite(report.unattributedChurnMb));
    assert.ok(!('clockOffsetMs' in report)); // per-child clocks: no global offset
    // Files + bucket add up to the all-rows total.
    const suiteChurn = report.suites.reduce((n, s) => n + s.churnMb, 0);
    assert.ok(Math.abs(suiteChurn + report.unattributedChurnMb - report.totalChurnMb) < 0.05);
    for (const suite of report.suites) {
      assert.deepEqual(Object.keys(suite).sort(), ['churnMb', 'gcs', 'growthMb', 'label']);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test('memory --badge writes the churn SVG (threshold drives the color)', () => {
  const root = buildFixtureProject();
  try {
    const badge = path.join(root, 'badges', 'memory.svg');
    const r = runCli(root, ['memory', '--badge', badge]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /badge written to/);
    const svg = readFileSync(badge, 'utf8');
    assert.match(svg, /aria-label="memory churn: \d+ MB"/);
    assert.match(svg, /<text x="[.\d]+" y="14">memory churn<\/text>/);
    // The fixture suite's churn is way under the default 500 MB → green.
    assert.match(svg, /fill="#4c1"/);
    // A tiny threshold flips the same suite to red (> 2 × threshold).
    const red = path.join(root, 'memory-red.svg');
    const r2 = runCli(root, ['memory', '--badge', red, '--badge-threshold', '0.01']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(readFileSync(red, 'utf8'), /fill="#e05d44"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test('memory exits 1 on usage errors and honors explicit file selection', () => {
  const root = buildFixtureProject();
  try {
    const bad = runCli(root, ['memory', '--format', 'yaml']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Invalid --format/);
    const missing = runCli(root, ['memory', 'nope']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no such path: nope/);
    const subset = runCli(root, ['memory', '--format', 'json', 'test/two.test.js']);
    assert.equal(subset.status, 0, subset.stderr);
    const report = JSON.parse(subset.stdout);
    assert.equal(report.suites.length, 1);
    assert.equal(report.suites[0].label, 'test' + path.sep + 'two.test.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

test('memory exits 1 on an empty test directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-memory-empty-'));
  try {
    mkdirSync(path.join(root, 'test'));
    const r = runCli(root, ['memory']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no test files found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory exits 0 even when tests fail (informational contract)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-memory-notests-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    mkdirSync(path.join(root, 'test'));
    writeFileSync(path.join(root, 'test', 'broken.test.js'), "throw new Error('load failure');\n");
    const r = runCli(root, ['memory', '--format', 'json']);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.testCount, 1);
    assert.equal(report.tests[0].result, 'fail');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 60_000 });
