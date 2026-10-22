// `memory` subcommand: per-test GC/allocation attribution.
//
// Port of crap4dart 3bae178 (memory: per-test GC/alloc attribution via
// --verbose_gc, phase 1). Upstream runs `dart --verbose_gc test
// --concurrency=1 -r json` and attributes GC rows to suites/tests. The
// JS analog runs the suite under `node --trace-gc`, one test FILE per
// sequential child run: node:test gives every file its own process, so
// the process boundary IS the file attribution — the analog of
// upstream's isolate-name/dill-index machinery (no straggler rows are
// possible across runs).
//
// What is summed (honest semantics): every --trace-gc row reports the
// WHOLE heap used before/after one collection,
// `<used> (<total>) -> <used> (<total>) MB`. V8's trace exposes no
// generation boundaries, so upstream's new-gen churn / old-gen growth
// split collapses to one counter pair per event:
//   churnMb      Σ max(0, usedBefore − usedAfter) — reclaimed heap volume
//   heapGrowthMb Σ (usedAfter − usedBefore)       — signed retained growth
// Rows of the runner process itself (`node --test` supervisor, its own
// pid) are unattributed bucket rows — the analog of upstream's
// unmatched-isolate rows. Churn totals are a function of the code under test
// (deterministic, the future gate metric); GC counts are not.
//
// Clocks and trust: trace-gc timestamps are ms since the CHILD process
// started — every file owns its clock (the analog of upstream phase 2's
// per-isolate clocks). Its zero is measured, not voted: the child's
// stderr rows stream unbuffered, so the first row's (arrival − ts) is
// the clock zero in wall time — the analog of upstream's suite event
// time marking the same zero. TAP ok-lines, by contrast, arrive in one
// buffered burst at child exit, so test windows are tiled back from the
// burst with real duration_ms values. Only rows INSIDE a test window
// are trusted; loading/teardown rows and the runner process's own rows
// land in an UNATTRIBUTED bucket that never pollutes file totals — the
// report carries the bucket separately. There is no global clock offset
// to calibrate: the per-child zero made phase 1's p90 vote machinery
// dead weight (removed, matching upstream). Rows cannot straggle across
// files (each child's pipes are read separately, rows stamped with the
// child pid) — upstream's seq-continuation guard has no analog here.
// Tiled windows are disjoint; a shared tile edge attributes to the
// earlier test.
//
// `--badge <path>` (+ `--badge-threshold MB`, default 500) writes a
// shields-style 'memory churn' SVG of the suite total.
//
// Informational: always exits 0; usage errors exit 1.

import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyGateArg } from './gateCommon.js';
import { badgeColorFor, renderBadgeSvg } from './badgeSvg.js';

const DEFAULT_TOP = 20;
const DEFAULT_SUITE_DIR = 'test';
// The TAP `type:` diagnostic of a real test (describe blocks report
// 'suite').
const TEST_TYPE = 'test';
const FORMATS = new Set(['console', 'json']);
const TEST_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

// One `node --trace-gc` row. When forwarded from the test child through
// the runner's reporter stream it carries a `# ` TAP-comment prefix
// (possibly indented) — same shape otherwise. The isolate header is
// V8's `[%d:%p]`: glibc/Darwin render `%p` as `0x…` lowercase hex,
// the MSVC CRT as bare uppercase hex — both accepted:
// [pid:0xaddr]  29 ms: Scavenge 37.6 (54.6) -> 34.3 (55.1) MB, pooled: 0 MB, 1.5 / 0.0 ms  (average mu = ...) allocation failure;
const GC_LINE =
  /^\s*#?\s*\[(\d+):(?:0x)?[0-9a-fA-F]+\]\s+(\d+) ms: (\S+) ([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB, pooled: [\d.]+ MB, ([\d.]+) \/ ([\d.]+) ms/;

/**
 * Parse one trace-gc row; null for every other line (TAP events, test
 * console output, noise).
 *
 * @param {string} line
 * @returns {{pid: number, tsMs: number, kind: string, usedBeforeMb: number, usedAfterMb: number, pauseMs: number} | null}
 */
export function parseGcLine(line) {
  const m = GC_LINE.exec(line);
  if (!m) return null;
  return {
    pid: Number(m[1]),
    tsMs: Number(m[2]),
    kind: m[3],
    usedBeforeMb: Number(m[4]),
    usedAfterMb: Number(m[6]),
    pauseMs: Number(m[8]),
  };
}

// Reclaimed heap volume of one collection (allocated volume that had
// accumulated since the previous one). Clamped at 0 — a growing heap
// between scavenges reclaims nothing.
export function reclaimedMb(gc) {
  return Math.max(0, gc.usedBeforeMb - gc.usedAfterMb);
}

// Signed retained growth across one collection (positive = survived,
// negative = freed) — the leak-suspect signal.
export function heapDeltaMb(gc) {
  return gc.usedAfterMb - gc.usedBeforeMb;
}

/**
 * Feeds timestamped lines of one run's TAP stream; completed tests
 * become spans. `ok N - name` opens a pending span, its YAML
 * diagnostics close it: end = wall time of the `...` terminator,
 * start = end − duration_ms (the `type:` diagnostic separates real
 * tests from describe/suite spans).
 */
export class TapSpans {
  constructor() {
    this.spans = [];
    this.pending = null;
  }

  addLine(wallMs, line) {
    if (this.pending) return this.diagnostic(wallMs, line);
    const m = /^(\s*)(not )?ok \d+ - (.+)$/.exec(line);
    if (m) {
      this.pending = {
        name: m[3].trim(),
        result: m[2] ? 'fail' : 'pass',
        durationMs: 0,
        lastWall: wallMs,
      };
    }
  }

  diagnostic(wallMs, line) {
    const p = this.pending;
    let m = /^\s*duration_ms: ([\d.]+)/.exec(line);
    if (m) p.durationMs = Number(m[1]);
    m = /^\s*type: '(\w+)'/.exec(line);
    if (m) p.type = m[1];
    p.lastWall = wallMs;
    if (/^\s*\.\.\.\s*$/.test(line)) {
      this.pending = null;
      this.spans.push({
        name: p.name,
        type: p.type || TEST_TYPE,
        result: p.result,
        startMs: wallMs - p.durationMs,
        endMs: wallMs,
      });
    }
  }

  // A stream cut before the diagnostics block: zero-width span at the
  // last arrival (the endOrStart fallback).
  flush() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    this.spans.push({
      name: p.name,
      type: p.type || TEST_TYPE,
      result: p.result,
      startMs: p.lastWall,
      endMs: p.lastWall,
    });
  }
}

/**
 * The full memory report of one profiled suite run. Totals span every
 * parsed row; file/test totals carry only window-attributed rows — the
 * difference is the unattributed bucket (loading, teardown, inter-test
 * gaps, runner-process rows), reported but never polluting files.
 *
 * @param {Array<{file: string, spawnWallMs: number, runnerPid: number,
 *   gcs: object[], spans: object[]}>} runs  one entry per profiled file
 * @param {string} root  directory report labels are relative to
 */
export function buildReport(runs, root) {
  const suites = [];
  const tests = [];
  const unattributed = [];
  let allRows = [];
  for (const run of runs) {
    const { child, runner } = splitRows(run);
    allRows = allRows.concat(child, runner);
    unattributed.push(...runner);
    const suite = {
      label: path.relative(root, run.file),
      gcs: 0,
      churnMb: 0,
      growthMb: 0,
    };
    suites.push(suite);
    // The child's GC-clock zero in wall time, measured from its own
    // first row (stderr streams unbuffered) — the analog of upstream's
    // suite event time marking the isolate-clock zero. No cross-file
    // vote exists: each file's clock is its own.
    const zeroMs = child.length
      ? child[0].arrWallMs - child[0].tsMs
      : run.spawnWallMs;
    const placed = placeSpans(run.spans);
    const order = placed
      .map((_, i) => i)
      .sort((a, b) => placed[a].startMs - placed[b].startMs);
    const entries = run.spans.map((span) => ({
      label: span.name,
      suite: suite.label,
      type: span.type,
      result: span.result,
      gcs: 0,
      churnMb: 0,
      growthMb: 0,
    }));
    for (const gc of child) {
      const i = spanIndexAt(placed, order, zeroMs + gc.tsMs);
      if (i < 0) {
        unattributed.push(gc); // loading / teardown row
        continue;
      }
      suite.gcs += 1;
      suite.churnMb += reclaimedMb(gc);
      suite.growthMb += heapDeltaMb(gc);
      entries[i].gcs += 1;
      entries[i].churnMb = round1(entries[i].churnMb + reclaimedMb(gc));
      entries[i].growthMb = round1(entries[i].growthMb + heapDeltaMb(gc));
    }
    suite.churnMb = round1(suite.churnMb);
    suite.growthMb = round1(suite.growthMb);
    tests.push(...entries);
  }
  return {
    testCount: tests.filter((t) => t.type === TEST_TYPE).length,
    gcCount: allRows.length,
    totalChurnMb: round1(allRows.reduce((n, gc) => n + reclaimedMb(gc), 0)),
    totalHeapGrowthMb: round1(allRows.reduce((n, gc) => n + heapDeltaMb(gc), 0)),
    unattributedCount: unattributed.length,
    unattributedChurnMb: round1(
      unattributed.reduce((n, gc) => n + reclaimedMb(gc), 0),
    ),
    suites,
    tests,
  };
}

// The run's rows split into test-child rows and true runner-process
// rows. Test-child = everything whose pid differs from the runner
// process's own (the analog of upstream's test_suite isolate filter).
// Process-boundary insurance: a topology that stamps every row with the
// runner pid (in-process isolation) must not fabricate zero churn —
// when the discriminator empties a non-empty set, the rows stay
// test-child rows (and the bucket stays empty).
function splitRows(run) {
  const child = run.gcs.filter((g) => g.pid !== run.runnerPid);
  if (child.length > 0) {
    return { child, runner: run.gcs.filter((g) => g.pid === run.runnerPid) };
  }
  // Insurance: every row stamped with the runner pid (in-process
  // isolation) — keep them all as test-child rows rather than
  // fabricating zero churn; the bucket stays empty.
  return { child: run.gcs, runner: [] };
}

// TAP ok-lines arrive in one buffered burst at child exit (the
// supervisor reprints the child's TAP only at the end), so arrival
// times carry no per-test placement — but durations are real, tests run
// sequentially, and the burst lands at the child's exit. So the windows
// are tiled back from the last arrival with real durations. This is the
// reduced form that replaces phase 1's global p90 offset vote: per-file
// anchoring only, nothing cross-file. ponytail: describe-nested spans
// tile flat (inner windows sit before the enclosing suite's), so
// per-test grain under describe is approximate — the row still counts
// toward its file.
function placeSpans(spans) {
  const order = spans
    .map((_, i) => i)
    .sort((a, b) => spans[a].endMs - spans[b].endMs);
  const placed = new Array(spans.length);
  let cursor = order.length ? spans[order[order.length - 1]].endMs : 0;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    const end = Math.min(cursor, spans[i].endMs);
    placed[i] = { startMs: end - (spans[i].endMs - spans[i].startMs), endMs: end };
    cursor = placed[i].startMs;
  }
  return placed;
}

// The span whose window contains rowMs. Upstream resolves overlaps to
// the narrower window; here the windows are tiled disjointly
// (placeSpans), so the first containing window in execution order IS
// the narrower rule's outcome — a shared tile edge attributes to the
// earlier test.
function spanIndexAt(placed, order, rowMs) {
  for (const i of order) {
    const s = placed[i];
    if (rowMs >= s.startMs && rowMs <= s.endMs) return i;
  }
  return -1;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Runs every file sequentially (`node --trace-gc --test
 * --test-reporter=tap <file>` — the concurrency=1 of this port) and
 * returns one run record per file.
 *
 * @param {string[]} files  absolute test file paths
 * @param {string} cwd  working directory for the child runs
 * @param {string} [execPath]
 */
export async function profileFiles(files, cwd, execPath = process.execPath) {
  const runs = [];
  for (const file of files) runs.push(await profileFile(file, cwd, execPath));
  return runs;
}

function profileFile(file, cwd, execPath) {
  return new Promise((resolve) => {
    const spawnWallMs = Date.now();
    // NODE_TEST_CONTEXT must not leak into profiled children: it flips
    // node:test into runner-child protocol mode (JSON on stdout, no
    // TAP) when the memory command itself runs under node --test.
    const { NODE_TEST_CONTEXT: _omit, ...env } = process.env;
    const child = spawn(
      execPath,
      ['--trace-gc', '--test', '--test-reporter=tap', file],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const gcs = [];
    const tap = new TapSpans();
    // Per-stream buffers: chunks from two pipes must never share a
    // partial line.
    const pumps = [
      { stream: child.stdout, buf: '' },
      { stream: child.stderr, buf: '' },
    ];
    for (const pump of pumps) {
      pump.stream.on('data', (chunk) => {
        pump.buf += chunk;
        let i;
        while ((i = pump.buf.indexOf('\n')) >= 0) {
          const line = pump.buf.slice(0, i);
          pump.buf = pump.buf.slice(i + 1);
          const gc = parseGcLine(line);
          // arrWallMs: live arrival — stderr rows stream unbuffered, so
          // (arrWallMs − tsMs) measures the child's clock zero directly.
          if (gc) gcs.push({ ...gc, arrWallMs: Date.now() });
          tap.addLine(Date.now(), line);
        }
      });
    }
    child.on('close', () => {
      tap.flush();
      resolve({
        file,
        spawnWallMs,
        runnerPid: child.pid,
        gcs,
        spans: tap.spans,
      });
    });
  });
}

// The wall-clock capture needs live pipe reads (spawnSync buffers and
// loses arrival times), so the sequential runs happen in a one-shot
// worker — the same shape as profile.js's collector children. The sync
// shell keeps the subcommand contract (ctx, exit codes) identical to
// every other command.
const WORKER_CODE = `
const { profileFiles } = await import(process.env.CRAP_MEMORY_MODULE);
const runs = await profileFiles(
  JSON.parse(process.env.CRAP_MEMORY_FILES),
  process.env.CRAP_MEMORY_CWD,
);
const { writeFileSync } = await import('node:fs');
writeFileSync(process.env.CRAP_MEMORY_OUT, JSON.stringify(runs));
`;

export function profileFilesSync(files, cwd) {
  const dir = mkdtempSync(path.join(tmpdir(), 'crap4js-memory-'));
  const out = path.join(dir, 'runs.json');
  try {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', WORKER_CODE],
      {
        env: {
          ...process.env,
          CRAP_MEMORY_MODULE: pathToFileURL(fileURLToPath(import.meta.url)).href,
          CRAP_MEMORY_FILES: JSON.stringify(files),
          CRAP_MEMORY_CWD: cwd,
          CRAP_MEMORY_OUT: out,
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    if (r.status !== 0 || !readFileSyncSafe(out)) {
      throw new Error('memory: profiling run failed');
    }
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readFileSyncSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Resolves the suite selection to absolute test file paths: a file
 * passes through, a directory expands to its .js/.mjs/.cjs files
 * (recursively — what `node --test <dir>` would run). Throws on missing
 * paths (usage error).
 *
 * @param {string[]} paths
 * @param {string} cwd
 */
export function collectTestFiles(paths, cwd) {
  const files = [];
  for (const p of paths) {
    const abs = path.resolve(cwd, p);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`no such path: ${p}`);
    }
    if (st.isDirectory()) files.push(...jsFilesUnder(abs));
    else files.push(abs);
  }
  return [...new Set(files)].sort();
}

function jsFilesUnder(dir) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...jsFilesUnder(full));
    else if (TEST_EXTENSIONS.has(path.extname(name))) found.push(full);
  }
  return found;
}

const VALUE_FLAGS = {
  '--top': 'top',
  '--format': 'format',
  '--badge': 'badge',
  '--badge-threshold': 'badgeThreshold',
};
const NUMBER_FLAGS = new Set(['--top', '--badge-threshold']);
const DEFAULT_BADGE_THRESHOLD = 500;

/**
 * Parse `memory` arguments into
 * `{ top, format, badge, badgeThreshold, paths }`. Value flags may be
 * written `--flag VALUE` or `--flag=VALUE`; `--top` is a positive
 * integer, `--format` is `console` (the default) or `json`,
 * `--badge-threshold` a non-negative number (default 500). Invalid
 * values throw (the CLI reports a usage error).
 *
 * @param {string[]} argv
 */
export function parseMemoryArgs(argv) {
  const opts = {
    top: DEFAULT_TOP,
    format: 'console',
    badge: null,
    badgeThreshold: DEFAULT_BADGE_THRESHOLD,
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  if (!FORMATS.has(opts.format)) {
    throw new Error(`Invalid --format: ${opts.format}`);
  }
  if (!Number.isInteger(opts.top) || opts.top < 1) {
    throw new Error(`Invalid --top: ${opts.top}`);
  }
  // --badge-threshold needs no extra validation: it is a number flag,
  // and applyGateArg's toGateNumber already rejects NaN and negatives.
  const stray = opts.paths.find((p) => p.startsWith('--'));
  if (stray) throw new Error(`unknown flag: ${stray}`);
  return opts;
}

/**
 * The `memory` command body: run the suite under --trace-gc, attribute
 * GC events and reclaimed memory to files and tests, report the
 * hotspots. Informational: always exits 0.
 *
 * @param {string[]} argv
 * @param {{out: object, err: object, cwd: string}} ctx
 * @returns {number} exit code
 */
export function runMemory(argv, ctx) {
  const opts = parseMemoryArgs(argv);
  const files = collectTestFiles(
    opts.paths.length ? opts.paths : [DEFAULT_SUITE_DIR],
    ctx.cwd,
  );
  if (files.length === 0) {
    ctx.err.write(`memory: no test files found in ${ctx.cwd}\n`);
    return 1;
  }
  ctx.err.write(
    `memory: running ${files.length} test file(s) under node --trace-gc (sequential)\n`,
  );
  const runs = profileFilesSync(files, ctx.cwd);
  const report = buildReport(runs, ctx.cwd);
  if (report.testCount === 0) {
    ctx.err.write('memory: no tests executed\n');
    return 1;
  }
  if (opts.format === 'json') {
    ctx.out.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printConsole(report, opts.top, ctx.out);
  }
  writeBadge(report, opts, ctx);
  return 0; // informational — thresholds come separately
}

// Writes the shields-style churn badge when --badge was given.
function writeBadge(report, opts, ctx) {
  if (!opts.badge) return;
  const color = badgeColorFor(report.totalChurnMb, opts.badgeThreshold);
  const svg = renderBadgeSvg(
    'memory churn',
    `${Math.round(report.totalChurnMb)} MB`,
    color,
  );
  mkdirSync(path.dirname(opts.badge), { recursive: true });
  writeFileSync(opts.badge, svg);
  ctx.err.write(`memory: badge written to ${opts.badge}\n`);
}

function printConsole(report, top, out) {
  const growth = report.totalHeapGrowthMb;
  out.write(
    `memory: ${report.testCount} tests, ${report.gcCount} GCs, ` +
      `churn ${report.totalChurnMb.toFixed(1)} MB reclaimed, ` +
      `heap ${growth >= 0 ? '+' : ''}${growth.toFixed(1)} MB\n`,
  );
  if (report.unattributedCount > 0) {
    out.write(
      `unattributed (loading/teardown/runner rows): ` +
        `${report.unattributedCount} GCs, ` +
        `${report.unattributedChurnMb.toFixed(1)} MB\n`,
    );
  }
  out.write('\ntop ' + top + ' by allocation churn (reclaimed heap MB):\n');
  printTable(byDesc(report.tests, 'churnMb').slice(0, top), out);
  out.write('\ntop ' + top + ' by heap growth (leak suspects first):\n');
  printTable(byDesc(report.tests, 'growthMb').slice(0, top), out);
}

function byDesc(entries, key) {
  return entries.filter((e) => e.gcs > 0).sort((a, b) => b[key] - a[key]);
}

function printTable(entries, out) {
  if (entries.length === 0) {
    out.write('  (no GC activity)\n');
    return;
  }
  out.write('  GCs  churn MB  growth MB  test\n');
  for (const e of entries) {
    out.write(
      String(e.gcs).padStart(5) +
        '  ' +
        e.churnMb.toFixed(1).padStart(9) +
        '  ' +
        e.growthMb.toFixed(1).padStart(10) +
        '  ' +
        e.label +
        '\n',
    );
  }
}
