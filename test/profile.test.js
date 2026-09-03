import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractMethods } from '../src/complexity.js';
import { instrumentSource } from '../src/instrument.js';
import {
  COLLECTOR_SOURCE,
  formatProfileReport,
  parseProfileArgs,
} from '../src/profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

test('instrumentSource wraps function bodies in enter + try/finally-exit', () => {
  const src = `export function add(a, b) {
  return a + b;
}
`;
  const out = instrumentSource(src, { ext: '.js', relFile: 'src/add.js' });
  assert.match(out, /__crap_enter\("src\/add\.js\|add"\);/);
  assert.match(out, /try \{/);
  assert.match(out, /__crap_exit\("src\/add\.js\|add"\);/);
  // The instrumented source still parses and yields the same entry.
  const methods = extractMethods(out, { ext: '.js' });
  assert.equal(methods.length, 1);
  assert.equal(methods[0].name, 'add');
});

test('instrumentSource wraps nested and class methods, skips arrow expressions', () => {
  const src = `export class Calc {
  twice(n) {
    const inc = () => { return n + n; };
    return inc();
  }
  get one() { return 1; }
}
export const id = (x) => x;
`;
  const out = instrumentSource(src, { ext: '.js', relFile: 'calc.js' });
  assert.match(out, /__crap_enter\("calc\.js\|Calc\.twice"/);
  assert.match(out, /__crap_enter\("calc\.js\|inc"/);
  assert.match(out, /__crap_enter\("calc\.js\|Calc\.one"/);
  // Arrow with an expression body has no block to wrap.
  assert.doesNotMatch(out, /calc\.js\|id/);
  extractMethods(out, { ext: '.js' }); // must not throw
});

test('collector aggregates calls/min/max and merges across processes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-collector-'));
  try {
    const preload = path.join(root, 'preload.mjs');
    const output = path.join(root, 'out.json');
    writeFileSync(preload, COLLECTOR_SOURCE);
    writeFileSync(
      path.join(root, 'driver.mjs'),
      `
      const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
      for (let i = 0; i < 2; i++) {
        globalThis.__crap_enter('src/a.js|f');
        busy(0.5);
        globalThis.__crap_exit('src/a.js|f');
      }
      globalThis.__crap_enter('src/b.js|g');
      busy(0.2);
      globalThis.__crap_exit('src/b.js|g');
      `,
    );
    const run = (file) =>
      spawnSync(process.execPath, [file], {
        cwd: root,
        env: {
          ...process.env,
          CRAP_PROFILE_OUTPUT: output,
          NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
        },
      });
    assert.equal(run(path.join(root, 'driver.mjs')).status, 0);
    assert.equal(run(path.join(root, 'driver.mjs')).status, 0);
    const data = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(data['src/a.js|f'].calls, 4); // 2 runs x 2 calls, merged
    assert.ok(data['src/a.js|f'].totalMicros >= 4 * 400);
    assert.ok(data['src/a.js|f'].minMicros <= data['src/a.js|f'].maxMicros);
    assert.ok(data['src/a.js|f'].totalSelfMicros <= data['src/a.js|f'].totalMicros);
    assert.equal(data['src/b.js|g'].calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression for crap4dart 0.9.5: the collector used to merge its CUMULATIVE
// in-memory counters into the output file on every flush (every 5 calls) and
// again at exit, inflating calls/total quadratically — 43 real calls merged
// as 5+10+...+40 = 180+ with impossible TOTALs.
test('collector flushes deltas only — counters stay exact across flushes (0.9.5)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-collector-flush-'));
  try {
    const preload = path.join(root, 'preload.mjs');
    const output = path.join(root, 'out.json');
    writeFileSync(preload, COLLECTOR_SOURCE);
    writeFileSync(
      path.join(root, 'driver.mjs'),
      `
      for (let i = 0; i < 43; i++) {
        globalThis.__crap_enter('src/a.js|f');
        globalThis.__crap_exit('src/a.js|f');
      }
      `,
    );
    const run = spawnSync(process.execPath, [path.join(root, 'driver.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        CRAP_PROFILE_OUTPUT: output,
        NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(data['src/a.js|f'].calls, 43); // 8 auto-flushes + exit flush, deltas only
    assert.ok(data['src/a.js|f'].totalMicros < 10000);
    assert.equal(data['src/a.js|f'].totalSelfMicros, data['src/a.js|f'].totalMicros);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collector self time excludes nested call time (0.9.5)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-collector-self-'));
  try {
    const preload = path.join(root, 'preload.mjs');
    const output = path.join(root, 'out.json');
    writeFileSync(preload, COLLECTOR_SOURCE);
    writeFileSync(
      path.join(root, 'driver.mjs'),
      `
      const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
      globalThis.__crap_enter('src/a.js|outer');
      busy(1);
      globalThis.__crap_enter('src/b.js|inner');
      busy(2);
      globalThis.__crap_exit('src/b.js|inner');
      globalThis.__crap_exit('src/a.js|outer');
      `,
    );
    const run = spawnSync(process.execPath, [path.join(root, 'driver.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        CRAP_PROFILE_OUTPUT: output,
        NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const data = JSON.parse(readFileSync(output, 'utf8'));
    const outer = data['src/a.js|outer'];
    const inner = data['src/b.js|inner'];
    assert.equal(outer.calls, 1);
    assert.equal(inner.calls, 1);
    // The nested call is fully contained in the parent's inclusive time.
    assert.ok(outer.totalMicros >= inner.totalMicros);
    // Parent's SELF excludes the nested call; the child keeps its own.
    assert.ok(outer.totalSelfMicros <= outer.totalMicros - inner.totalMicros);
    assert.ok(outer.totalSelfMicros >= 0);
    assert.ok(inner.totalSelfMicros >= 0);
    assert.ok(inner.totalSelfMicros <= inner.totalMicros);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('formatProfileReport sorts by TOTAL, limits top, formats threshold line', () => {
  const profiles = [
    { method: 'fast', file: 'src/a.js', line: 1, calls: 10, totalMicros: 100, minMicros: 5, maxMicros: 20 },
    { method: 'slow', file: 'src/b.js', line: 2, calls: 2, totalMicros: 900, minMicros: 400, maxMicros: 500 },
  ];
  const out = formatProfileReport(profiles, { top: 1, thresholdMs: 0.5 });
  assert.match(out, /Profile Report \(2 methods, total 1\.00ms\)/);
  assert.match(out, /TOTAL\s+SELF/);
  assert.match(out, /@60fps\(ms\)/);
  assert.ok(out.includes('slow') && !out.includes('fast')); // top=1, sorted desc
  assert.match(out, /90\.0%/);
  assert.match(out, /Threshold: 0\.50ms — 1 method\(s\) exceed/);
  // No threshold → no threshold line.
  assert.doesNotMatch(formatProfileReport(profiles, { top: 5 }), /Threshold/);
});

test('formatProfileReport top=0 shows all rows', () => {
  const profiles = [
    { method: 'a', file: 'f.js', line: 1, calls: 1, totalMicros: 10, minMicros: 10, maxMicros: 10 },
    { method: 'b', file: 'f.js', line: 2, calls: 1, totalMicros: 20, minMicros: 20, maxMicros: 20 },
  ];
  const out = formatProfileReport(profiles, { top: 0 });
  assert.match(out, /METHOD/);
  assert.match(out, /f\.js:1/);
  assert.match(out, /f\.js:2/);
});

test('formatProfileReport marks sub-30µs means with ~ (0.9.2)', () => {
  const profiles = [
    // mean 300µs — trustworthy; mean 12µs — instrumentation noise.
    { method: 'real', file: 'f.js', line: 1, calls: 10, totalMicros: 3000, minMicros: 100, maxMicros: 500 },
    { method: 'noise', file: 'f.js', line: 2, calls: 10, totalMicros: 120, minMicros: 5, maxMicros: 30 },
  ];
  const out = formatProfileReport(profiles, { top: 0 });
  assert.match(out, /\s300\.0\s/);
  assert.doesNotMatch(out, /~300\.0/);
  assert.match(out, /~12\.0/);
});

test('formatProfileReport renders TOTAL/SELF with adaptive units (0.9.5)', () => {
  const report = (totalMicros) =>
    formatProfileReport(
      [{ method: 'f', file: 'f.js', line: 1, calls: 1, totalMicros, totalSelfMicros: 0, minMicros: 1, maxMicros: totalMicros }],
      { top: 1 },
    );
  // Tiers: <1000ms, <60s, <60m, else hours — always 2 decimals.
  assert.match(report(999_950), /total 999\.95ms/);
  assert.match(report(1_000_000), /total 1\.00s/);
  assert.match(report(59_999_000), /total 60\.00s/); // 59999ms rounds up inside the s tier
  assert.match(report(60_000_000), /total 1\.00m/);
  assert.match(report(3_599_999_000), /total 60\.00m/); // 3599999ms rounds up inside the m tier
  assert.match(report(3_600_000_000), /total 1\.00h/);
  // Tens of billions of calls used to render a wall of digits (`50000000.00`).
  assert.match(report(50_000_000_000), /total 13\.89h/);
});

test('formatProfileReport shows SELF from totalSelfMicros (0.9.5)', () => {
  const profiles = [
    { method: 'outer', file: 'src/a.js', line: 1, calls: 100, totalMicros: 5000000, totalSelfMicros: 2000000, minMicros: 100, maxMicros: 90000 },
  ];
  const out = formatProfileReport(profiles, { top: 1 });
  assert.match(out, /TOTAL\s+SELF\s+%\s+CALLS/); // SELF right after TOTAL
  assert.match(out, /5\.00s/); // TOTAL — inclusive
  assert.match(out, /2\.00s/); // SELF
});

test('parseProfileArgs rejects unknown flags and bad values', () => {
  assert.throws(() => parseProfileArgs(['--bogus']), /Unknown flag/);
  assert.throws(() => parseProfileArgs(['--top']), /requires a value/);
  assert.throws(() => parseProfileArgs(['--top', 'abc']), /Invalid top/);
  assert.throws(() => parseProfileArgs(['--threshold', '-1']), /Invalid threshold/);
});

test('parseProfileArgs defaults: threshold off, top 20', () => {
  const opts = parseProfileArgs(['--name', 'collab', 'test/x.test.js']);
  assert.equal(opts.name, 'collab');
  assert.deepEqual(opts.paths, ['test/x.test.js']);
  assert.equal(opts.thresholdMs, null);
  assert.equal(opts.topN, 20);
});

test('profile end-to-end: instrumented run reports methods and writes reports', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-profile-'));
  try {
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'test'));
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
      path.join(root, 'src', 'add.js'),
      'export function add(a, b) {\n  return a + b;\n}\n',
    );
    writeFileSync(
      path.join(root, 'test', 'add.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert';",
        "import { add } from '../src/add.js';",
        "test('add works', () => assert.equal(add(1, 2), 3));",
        '',
      ].join('\n'),
    );
    const ok = runCli(root, ['profile']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Profile Report \(1 methods/);
    assert.match(ok.stdout, /add\s+src\/add\.js:1/);
    // Full reports written.
    const reports = readdirJson(root);
    assert.equal(reports.txt.length, 1);
    assert.equal(reports.json.length, 1);
    const json = JSON.parse(readFileSync(reports.json[0], 'utf8'));
    assert.equal(json.methods[0].method, 'add');
    assert.ok(json.methods[0].totalMicros > 0);
    assert.ok(json.methods[0].totalSelfMicros >= 0); // 0.9.5 JSON contract
    // Temp copy cleaned up.
    assert.ok(!existsSync(path.join(root, '.crap_profile_temp')));

    // Threshold 0ms: add's total exceeds it → exit 2.
    const over = runCli(root, ['profile', '--threshold', '0']);
    assert.equal(over.status, 2);
    assert.match(over.stderr, /Profile threshold exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('profile positional path selects the test to run from the instrumented copy (0.9.2)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-profile-path-'));
  try {
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'test'));
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
      path.join(root, 'src', 'add.js'),
      'export function add(a, b) {\n  return a + b;\n}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'mul.js'),
      'export function mul(a, b) {\n  return a * b;\n}\n',
    );
    writeFileSync(
      path.join(root, 'test', 'add.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert';",
        "import { add } from '../src/add.js';",
        "import { mul } from '../src/mul.js';",
        "test('add works', () => assert.equal(add(1, mul(2, 2)), 5));",
        '',
      ].join('\n'),
    );
    // Only ONE of the two test files is selected; the FULL src/ set is
    // still instrumented and attributed — and the run executes the temp
    // copy, not the original files.
    const r = runCli(root, ['profile', 'test/add.test.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Profile Report \(2 methods/);
    assert.match(r.stdout, /add\s+src\/add\.js:1/);
    assert.match(r.stdout, /mul\s+src\/mul\.js:1/);
    assert.ok(!existsSync(path.join(root, '.crap_profile_temp')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('profile with explicit path runs ONLY it — no default suite appended (0.9.3)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-profile-only-'));
  try {
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'test'));
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
      path.join(root, 'src', 'add.js'),
      'export function add(a, b) {\n  return a + b;\n}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'mul.js'),
      'export function mul(a, b) {\n  return a * b;\n}\n',
    );
    writeFileSync(
      path.join(root, 'test', 'add.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert';",
        "import { add } from '../src/add.js';",
        "test('add works', () => assert.equal(add(1, 2), 3));",
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'test', 'mul.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert';",
        "import { mul } from '../src/mul.js';",
        "test('mul works', () => assert.equal(mul(2, 2), 4));",
        '',
      ].join('\n'),
    );
    // Only mul.test.js is handed to `node --test`: the other test file must
    // not run, so only mul gets timings and appears in the report. The port
    // never appends a default suite selector alongside explicit paths
    // (crap4dart 0.9.3 — node --test treats positional paths as the whole
    // run set, so this pins the already-correct contract).
    const r = runCli(root, ['profile', 'test/mul.test.js']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Profile Report \(1 methods/);
    assert.match(r.stdout, /mul\s+src\/mul\.js:1/);
    assert.doesNotMatch(r.stdout, /add/);

    // Without paths, default discovery still runs the whole suite.
    const all = runCli(root, ['profile']);
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /add\s+src\/add\.js:1/);
    assert.match(all.stdout, /mul\s+src\/mul\.js:1/);
    assert.ok(!existsSync(path.join(root, '.crap_profile_temp')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('profile survives failing tests: warns on stderr, still reports', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-profile-fail-'));
  try {
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'test'));
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
      path.join(root, 'src', 'add.js'),
      'export function add(a, b) {\n  return a + b;\n}\n',
    );
    // Fails, but only after calling the instrumented function — the exit
    // hook still flushes the collector data.
    writeFileSync(
      path.join(root, 'test', 'add.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert';",
        "import { add } from '../src/add.js';",
        "test('add works', () => assert.equal(add(1, add(2, 3)), 99));",
        '',
      ].join('\n'),
    );
    const r = runCli(root, ['profile']);
    assert.match(r.stderr, /Warning: tests exited with code 1/);
    assert.match(r.stdout, /add\s+src\/add\.js:1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readdirJson(root) {
  const dir = path.join(root, 'profile-reports');
  const names = existsSync(dir) ? readdirSync(dir) : [];
  return {
    txt: names.filter((n) => n.endsWith('.txt')).map((n) => path.join(dir, n)),
    json: names.filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n)),
  };
}
