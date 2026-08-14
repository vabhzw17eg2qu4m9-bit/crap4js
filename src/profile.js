// `profile` subcommand: source-instrumentation CPU profiler.
//
// Creates a temporary copy of the project inside `<root>/.crap_profile_temp`
// (a child of the project root, so `node_modules` resolution walks up to the
// real project's dependencies), instruments every analyzed function body
// (see instrument.js), runs `node --test` with a collector preloaded via
// NODE_OPTIONS, then attributes the recorded timings to the analyzer's
// method inventory and renders the report table.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyze } from './analyzer.js';
import { expandPaths, findSourceFiles } from './files.js';
import { instrumentSource } from './instrument.js';
import { padLeft, padRight } from './report.js';

const TEMP_DIR = '.crap_profile_temp';
const PRELOAD_NAME = '__crap_preload.mjs';
const DEFAULT_TOP = 20;

// Source of the collector preload written into the temp copy and injected
// into every node process via NODE_OPTIONS `--import`. It installs
// globalThis.__crap_record and merges per-method stats into the output file
// (temp file + rename) on every flush, so parallel test processes aggregate
// without races — `node --test` runs each test file in its own process.
const COLLECTOR_SOURCE = `
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const stats = new Map();
let calls = 0;

globalThis.__crap_record = (key, startMs) => {
  const micros = Math.max(0, Math.round((performance.now() - startMs) * 1000));
  const s = stats.get(key) || { calls: 0, totalMicros: 0, minMicros: Infinity, maxMicros: 0 };
  s.calls++;
  s.totalMicros += micros;
  if (micros < s.minMicros) s.minMicros = micros;
  if (micros > s.maxMicros) s.maxMicros = micros;
  stats.set(key, s);
  if (++calls % 25 === 0) flush(); // periodic flush guards against crashes
};

process.on('exit', flush);

function flush() {
  const out = process.env.CRAP_PROFILE_OUTPUT;
  if (!out || stats.size === 0) return;
  const merged = readMerged(out);
  for (const [key, s] of stats) mergeEntry(merged, key, s);
  const tmp = out + '.' + process.pid + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(merged));
    renameSync(tmp, out);
  } catch {
    // Best effort — a lost flush only loses timing precision.
  }
}

function readMerged(out) {
  try {
    return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  } catch {
    return {}; // corrupt or half-written file — start fresh
  }
}

function mergeEntry(merged, key, s) {
  const ex = merged[key];
  if (!ex) {
    merged[key] = { calls: s.calls, totalMicros: s.totalMicros, minMicros: s.minMicros, maxMicros: s.maxMicros };
    return;
  }
  ex.calls += s.calls;
  ex.totalMicros += s.totalMicros;
  ex.minMicros = Math.min(ex.minMicros, s.minMicros);
  ex.maxMicros = Math.max(ex.maxMicros, s.maxMicros);
}
`;

/**
 * Parse `profile` subcommand arguments.
 *
 * Flags: `--name <pattern>` (test-name pattern), `--threshold <ms>`
 * (default off), `--top <N>` (default 20). Everything else is a test/source
 * path. Throws on unknown flags and invalid values.
 */
export function parseProfileArgs(argv) {
  const raw = { paths: [], name: undefined, threshold: undefined, top: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') raw.name = requireValue(argv, ++i, a);
    else if (a === '--threshold') raw.threshold = requireValue(argv, ++i, a);
    else if (a === '--top') raw.top = requireValue(argv, ++i, a);
    else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    else raw.paths.push(a);
  }
  return { ...raw, thresholdMs: parseMs(raw.threshold), topN: parseTop(raw.top) };
}

/**
 * The `profile` command body: instrument, run tests, attribute, report.
 * Returns 0 on success, 1 when no profiling data was produced, 2 when a
 * method's total exceeds the threshold.
 */
export function runProfile(opts, ctx) {
  const files = profileFiles(opts.paths, ctx.cwd);
  if (files.length === 0) {
    ctx.out.write('No JavaScript files to profile.\n');
    return 0;
  }
  const timings = runInstrumentedTests(files, opts, ctx);
  if (!timings) return 1;
  const profiles = attribute(timings, methodInventory(files, ctx.cwd));
  writeReports(profiles, ctx.cwd);
  ctx.out.write(formatProfileReport(profiles, opts));
  return profileVerdict(profiles, opts.thresholdMs, ctx);
}

function profileFiles(paths, projectRoot) {
  return paths.length > 0 ? expandPaths(paths, projectRoot) : findSourceFiles(projectRoot);
}

// Runs `node --test` against the instrumented copy; returns the timings
// object (key → stats), or null when no data was produced.
function runInstrumentedTests(files, opts, ctx) {
  const tempDir = path.join(ctx.cwd, TEMP_DIR);
  prepareTempCopy(files, tempDir, ctx.cwd);
  const outputFile = path.join(tempDir, '.crap_profile.json');
  ctx.err.write('Running instrumented tests...\n');
  const result = spawnSync(process.execPath, testArgs(opts), {
    cwd: tempDir,
    env: testEnv(tempDir, outputFile),
  });
  const timings = readTimings(outputFile);
  cleanupTemp(tempDir);
  reportTestFailure(result, ctx);
  if (!timings) ctx.err.write('No profiling data was produced.\n');
  return timings;
}

function testArgs(opts) {
  return opts.name
    ? ['--test', '--test-name-pattern', opts.name]
    : ['--test'];
}

function testEnv(tempDir, outputFile) {
  const preload = pathToFileURL(path.join(tempDir, PRELOAD_NAME)).href;
  const nodeOptions = [`--import ${preload}`, process.env.NODE_OPTIONS]
    .filter(Boolean)
    .join(' ');
  // NODE_TEST_CONTEXT (set when running under `node --test`) would make the
  // inner `node --test` believe it is a child test file and skip everything.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return {
    ...env,
    CRAP_PROFILE_OUTPUT: outputFile,
    NODE_OPTIONS: nodeOptions,
  };
}

// Copies the pieces the test run needs into the temp dir, then overwrites
// the analyzed sources with instrumented versions at the same relative
// paths and writes the collector preload.
function prepareTempCopy(files, tempDir, root) {
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  copyIfExists(path.join(root, 'package.json'), path.join(tempDir, 'package.json'));
  copyIfExists(path.join(root, 'test'), path.join(tempDir, 'test'));
  copyIfExists(path.join(root, 'src'), path.join(tempDir, 'src'));
  for (const file of files) {
    writeInstrumented(file, root, tempDir);
  }
  writeFileSync(path.join(tempDir, PRELOAD_NAME), COLLECTOR_SOURCE);
}

function copyIfExists(src, dest) {
  if (existsSync(src)) cpSync(src, dest, { recursive: true });
}

function writeInstrumented(file, root, tempDir) {
  const rel = path.relative(root, file);
  const dest = path.join(tempDir, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, instrumentedContent(file, root, rel));
}

// Files that fail to parse are copied verbatim (silently) — same policy as
// upstream crap4dart's instrumenter.
function instrumentedContent(file, root, rel) {
  const source = readFileSync(file, 'utf8');
  try {
    return instrumentSource(source, {
      ext: path.extname(file),
      relFile: rel.split(path.sep).join('/'),
    });
  } catch {
    return source;
  }
}

function cleanupTemp(tempDir) {
  if (process.env.CRAP_PROFILE_DEBUG == null) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Like upstream crap4dart: test output is captured and only the tail is
// printed (to stderr) when the run fails.
function reportTestFailure(result, ctx) {
  if (result.status === 0) return;
  ctx.err.write(`Warning: tests exited with code ${result.status}.\n`);
  for (const stream of [result.stderr, result.stdout]) {
    const lines = String(stream).trim().split('\n');
    if (lines[0]) ctx.err.write(lines.slice(-30).join('\n') + '\n');
  }
}

function readTimings(outputFile) {
  if (!existsSync(outputFile)) return null;
  try {
    return JSON.parse(readFileSync(outputFile, 'utf8'));
  } catch {
    return null;
  }
}

// The analyzer's method inventory (coverage-free) — same parsing as the
// default analyze path, so keys line up with the instrumentation keys.
function methodInventory(files, projectRoot) {
  const { metrics } = analyze({
    filePaths: files,
    coveragePath: null,
    projectRoot,
  });
  return metrics;
}

// Matches timing entries to the inventory by "<relFile>|<methodName>" key.
// Unmatched entries are ignored.
function attribute(timings, metrics) {
  const profiles = [];
  for (const m of metrics) {
    const t = timings[`${m.file}|${m.methodName}`];
    if (t) {
      profiles.push({ method: m.methodName, file: m.file, line: m.startLine, ...t });
    }
  }
  return profiles;
}

export function totalMicros(profiles) {
  return profiles.reduce((sum, p) => sum + p.totalMicros, 0);
}

/**
 * Renders the console report: header line, table sorted by TOTAL desc and
 * limited to `top` rows, then the threshold verdict when one is set.
 *
 * @param {Array<object>} profiles  attributed rows ({method, file, line, calls, totalMicros, maxMicros})
 * @param {{top?: number, thresholdMs?: number|null}} [opts]
 * @returns {string}
 */
export function formatProfileReport(profiles, { top = DEFAULT_TOP, thresholdMs } = {}) {
  const sorted = sortByTotal(profiles);
  const total = totalMicros(sorted);
  const shown = top > 0 ? sorted.slice(0, top) : sorted;
  const header = tableHeader();
  let out = `Profile Report (${profiles.length} methods, total ${ms(total)}ms)\n`;
  out += `${header}\n${'-'.repeat(header.length)}\n`;
  for (const p of shown) {
    out += profileRow(p, total) + '\n';
  }
  out += `Full report: profile-reports/ (txt + json)\n`;
  if (thresholdMs != null) out += thresholdLine(profiles, thresholdMs);
  return out;
}

function tableHeader() {
  return (
    padLeft('TOTAL(ms)', 10) +
    ' ' +
    padLeft('%', 6) +
    ' ' +
    padLeft('CALLS', 6) +
    ' ' +
    padLeft('MEAN(µs)', 10) +
    ' ' +
    padLeft('MAX(µs)', 9) +
    ' ' +
    padLeft('@60fps(ms)', 11) +
    ' ' +
    padRight('METHOD', 30) +
    ' ' +
    'FILE:LINE'
  );
}

function profileRow(p, total) {
  const mean = p.calls > 0 ? p.totalMicros / p.calls : 0;
  const pct = total > 0 ? (p.totalMicros / total) * 100 : 0;
  return (
    padLeft(ms(p.totalMicros), 10) +
    ' ' +
    padLeft(pct.toFixed(1) + '%', 6) +
    ' ' +
    padLeft(String(p.calls), 6) +
    ' ' +
    padLeft(mean.toFixed(1), 10) +
    ' ' +
    padLeft(String(p.maxMicros), 9) +
    ' ' +
    padLeft(ms(mean * 60), 11) +
    ' ' +
    padRight(p.method, 30) +
    ' ' +
    `${p.file}:${p.line}`
  );
}

function thresholdLine(profiles, thresholdMs) {
  const over = countOver(profiles, thresholdMs);
  const verdict = over > 0 ? `${over} method(s) exceed` : 'all methods OK';
  return `Threshold: ${thresholdMs.toFixed(2)}ms — ${verdict}\n`;
}

function countOver(profiles, thresholdMs) {
  return profiles.filter((p) => p.totalMicros / 1000 > thresholdMs).length;
}

function profileVerdict(profiles, thresholdMs, ctx) {
  if (thresholdMs == null) return 0;
  if (countOver(profiles, thresholdMs) > 0) {
    ctx.err.write(`Profile threshold exceeded: methods over ${thresholdMs}ms\n`);
    return 2;
  }
  return 0;
}

// Writes the full (untruncated) reports for later analysis.
function writeReports(profiles, root) {
  const dir = path.join(root, 'profile-reports');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sorted = sortByTotal(profiles);
  writeFileSync(
    path.join(dir, `profile-${stamp}.txt`),
    formatProfileReport(sorted, { top: 0 }) + '\n',
  );
  writeFileSync(
    path.join(dir, `profile-${stamp}.json`),
    JSON.stringify(reportJson(sorted), null, 2) + '\n',
  );
}

function reportJson(sorted) {
  return {
    generatedAt: new Date().toISOString(),
    totalMicros: totalMicros(sorted),
    methods: sorted.map(({ method, file, line, calls, totalMicros, minMicros, maxMicros }) => ({
      method,
      file,
      line,
      calls,
      totalMicros,
      minMicros,
      maxMicros,
    })),
  };
}

function sortByTotal(profiles) {
  return [...profiles].sort((a, b) => b.totalMicros - a.totalMicros);
}

function ms(micros) {
  return (micros / 1000).toFixed(2);
}

function requireValue(argv, i, flag) {
  const v = argv[i];
  if (v == null) throw new Error(`${flag} requires a value`);
  return v;
}

function parseMs(value) {
  if (value === undefined) return null;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) throw new Error(`Invalid threshold: ${value}`);
  return n;
}

function parseTop(value) {
  if (value === undefined) return DEFAULT_TOP;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid top: ${value}`);
  return n;
}

export { COLLECTOR_SOURCE };
