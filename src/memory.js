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
// pid) are excluded — the analog of upstream's test_suite isolate
// filter. Churn totals are a function of the code under test
// (deterministic, the future gate metric); GC counts are not.
//
// Clocks: trace-gc timestamps are ms since the child process started;
// TAP spans get wall-clock ends from line-arrival times. One GLOBAL
// offset (gc clock − reporter clock) is voted per file by
// (last child GC − end of its last test) at the 90th percentile —
// upstream's exact mechanism, absorbing the spawn→V8-init latency. A
// loading GC (before a file's first test start) counts toward file
// totals only; nested windows resolve to the shorter span.
//
// Informational: always exits 0; usage errors exit 1.

import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
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
 * The full memory report of one profiled suite run.
 *
 * @param {Array<{file: string, spawnWallMs: number, runnerPid: number,
 *   gcs: object[], spans: object[]}>} runs  one entry per profiled file
 * @param {string} root  directory report labels are relative to
 */
export function buildReport(runs, root) {
  const offset = globalOffset(runs);
  const suites = [];
  const tests = [];
  let totalGcs = 0;
  for (const run of runs) {
    const childGcs = childRows(run);
    totalGcs += childGcs.length;
    const suite = {
      label: path.relative(root, run.file),
      gcs: childGcs.length,
      churnMb: sumMb(childGcs, reclaimedMb),
      growthMb: sumMb(childGcs, heapDeltaMb),
    };
    suites.push(suite);
    const order = run.spans
      .map((_, i) => i)
      .sort((a, b) => run.spans[a].startMs - run.spans[b].startMs);
    const firstStart = order.length ? run.spans[order[0]].startMs : Infinity;
    const entries = run.spans.map((span) => ({
      label: span.name,
      suite: suite.label,
      type: span.type,
      result: span.result,
      gcs: 0,
      churnMb: 0,
      growthMb: 0,
    }));
    for (const gc of childGcs) {
      const gcMs = run.spawnWallMs + gc.tsMs - offset;
      if (gcMs < firstStart) continue; // loading GC: file total only
      const i = spanIndexAt(run.spans, order, gcMs);
      if (i < 0) continue;
      entries[i].gcs += 1;
      entries[i].churnMb = round1(entries[i].churnMb + reclaimedMb(gc));
      entries[i].growthMb = round1(entries[i].growthMb + heapDeltaMb(gc));
    }
    tests.push(...entries);
  }
  return {
    testCount: tests.filter((t) => t.type === TEST_TYPE).length,
    gcCount: totalGcs,
    totalChurnMb: round1(suites.reduce((n, s) => n + s.churnMb, 0)),
    totalHeapGrowthMb: round1(suites.reduce((n, s) => n + s.growthMb, 0)),
    clockOffsetMs: round1(offset),
    suites,
    tests,
  };
}

// The run's test-child rows: everything whose pid differs from the
// runner process's own (the analog of upstream's test_suite isolate
// filter). Process-boundary insurance: a topology that stamps every row
// with the runner pid (in-process isolation) must not fabricate zero
// churn — when the discriminator empties a non-empty set, keep the rows.
function childRows(run) {
  const rows = run.gcs.filter((g) => g.pid !== run.runnerPid);
  return rows.length > 0 || run.gcs.length === 0 ? rows : run.gcs;
}

// One GLOBAL offset (gc clock − reporter wall clock), voted per file by
// (last child GC − end of its last test) at the 90th percentile. A file
// whose last GC fires before its last test ends votes below the truth;
// teardown GCs vote above it — the p90 sits just under the truth and
// ignores both tails. Files without GCs or spans cast no vote.
function globalOffset(runs) {
  const votes = [];
  for (const run of runs) {
    const childGcs = childRows(run);
    if (childGcs.length === 0 || run.spans.length === 0) continue;
    const lastGc = Math.max(...childGcs.map((g) => g.tsMs));
    const lastEnd = Math.max(...run.spans.map((s) => s.endMs));
    votes.push(run.spawnWallMs + lastGc - lastEnd);
  }
  if (votes.length === 0) return 0;
  votes.sort((a, b) => a - b);
  return votes[Math.min(Math.floor(votes.length * 0.9), votes.length - 1)];
}

// The span whose window contains gcMs, preferring the smallest —
// upstream's nested-window rule.
function spanIndexAt(spans, order, ms) {
  let best = -1;
  let bestWidth = Infinity;
  for (const i of order) {
    const s = spans[i];
    const width = s.endMs - s.startMs;
    if (ms >= s.startMs && ms <= s.endMs && width < bestWidth) {
      best = i;
      bestWidth = width;
    }
  }
  return best;
}

function sumMb(gcs, metric) {
  return round1(gcs.reduce((n, gc) => n + metric(gc), 0));
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
          if (gc) gcs.push(gc);
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

const VALUE_FLAGS = { '--top': 'top', '--format': 'format' };
const NUMBER_FLAGS = new Set(['--top']);

/**
 * Parse `memory` arguments into `{ top, format, paths }`. Value flags
 * may be written `--flag VALUE` or `--flag=VALUE`; `--top` is a
 * positive integer, `--format` is `console` (the default) or `json`.
 * Invalid values throw (the CLI reports a usage error).
 *
 * @param {string[]} argv
 */
export function parseMemoryArgs(argv) {
  const opts = { top: DEFAULT_TOP, format: 'console', paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  if (!FORMATS.has(opts.format)) {
    throw new Error(`Invalid --format: ${opts.format}`);
  }
  if (!Number.isInteger(opts.top) || opts.top < 1) {
    throw new Error(`Invalid --top: ${opts.top}`);
  }
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
  return 0; // informational — thresholds come separately
}

function printConsole(report, top, out) {
  const growth = report.totalHeapGrowthMb;
  out.write(
    `memory: ${report.testCount} tests, ${report.gcCount} GCs, ` +
      `churn ${report.totalChurnMb.toFixed(1)} MB reclaimed, ` +
      `heap ${growth >= 0 ? '+' : ''}${growth.toFixed(1)} MB, ` +
      `clock offset ${report.clockOffsetMs.toFixed(1)} ms\n`,
  );
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
