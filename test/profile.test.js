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

test('instrumentSource wraps function bodies in try/finally + record', () => {
  const src = `export function add(a, b) {
  return a + b;
}
`;
  const out = instrumentSource(src, { ext: '.js', relFile: 'src/add.js' });
  assert.match(out, /const __crap_t0 = performance\.now\(\);/);
  assert.match(out, /try \{/);
  assert.match(out, /__crap_record\("src\/add\.js\|add", __crap_t0\);/);
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
  assert.match(out, /__crap_record\("calc\.js\|Calc\.twice"/);
  assert.match(out, /__crap_record\("calc\.js\|inc"/);
  assert.match(out, /__crap_record\("calc\.js\|Calc\.one"/);
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
      globalThis.__crap_record('src/a.js|f', performance.now() - 0.5);
      globalThis.__crap_record('src/a.js|f', performance.now() - 1.5);
      globalThis.__crap_record('src/b.js|g', performance.now() - 0.2);
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
    assert.equal(data['src/b.js|g'].calls, 2);
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
  assert.match(out, /TOTAL\(ms\)/);
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
