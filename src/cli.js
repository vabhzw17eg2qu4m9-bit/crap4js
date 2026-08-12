#!/usr/bin/env node
// crap4js CLI entry point.
//
// Usage:
//   crap4js                  Analyze all .js/.jsx/.ts/.tsx/.mjs/.cjs under src/.
//   crap4js --changed        Analyze git-changed files under src/.
//   crap4js <path>...        Analyze explicit files / directories.
//   crap4js --help           Print this help and exit 0.
//   crap4js --coverage <p>   Override coverage file (default coverage/coverage-final.json).
//   crap4js --threshold <n>  Override CRAP threshold (default 8.0).
//   crap4js --run-tests      Run `nyc node --test` before analyzing.
//
// Exit codes: 0 success; 1 usage error; 2 CRAP threshold exceeded.

import path from 'node:path';
import { analyze } from './analyzer.js';
import { formatReport } from './report.js';
import { changedFiles, expandPaths, findSourceFiles } from './files.js';
import { runTests } from './runtests.js';

const DEFAULT_THRESHOLD = 8.0;
const DEFAULT_COVERAGE = 'coverage/coverage-final.json';

function usage() {
  return [
    'Usage:',
    '  crap4js                  Analyze all .js/.jsx/.ts/.tsx/.mjs/.cjs files under src/',
    '  crap4js --changed        Analyze git-changed source files under src/',
    '  crap4js <path>...        Analyze explicit files / directories (expanded)',
    '  crap4js --help           Print this help message',
    '  crap4js --coverage <p>   Override coverage file (default: ' + DEFAULT_COVERAGE + ')',
    '  crap4js --threshold <n>  Override CRAP threshold (default: ' + DEFAULT_THRESHOLD + ')',
    '  crap4js --run-tests      Run the test+coverage suite before analyzing',
    '',
  ].join('\n');
}

const SIMPLE_FLAGS = {
  '--help': 'help',
  '-h': 'help',
  '--changed': 'changed',
  '--run-tests': 'runTests',
};

function parseArgs(argv) {
  const opts = newOpts();
  for (let i = 0; i < argv.length; i++) {
    i = applyArg(opts, argv, i);
  }
  validateOpts(opts);
  opts.thresholdValue = parseThreshold(opts.threshold);
  return opts;
}

function newOpts() {
  return {
    paths: [],
    changed: false,
    help: false,
    coverage: undefined,
    threshold: undefined,
    runTests: false,
  };
}

function applyArg(opts, argv, i) {
  const a = argv[i];
  const simple = SIMPLE_FLAGS[a];
  if (simple) {
    opts[simple] = true;
    return i;
  }
  if (isFlag(a, '--coverage')) return takeValue(opts, 'coverage', a, argv, i);
  if (isFlag(a, '--threshold')) return takeValue(opts, 'threshold', a, argv, i);
  if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
  opts.paths.push(a);
  return i;
}

function isFlag(a, flag) {
  return a === flag || a.startsWith(flag + '=');
}

function takeValue(opts, key, a, argv, i) {
  const prefix = `--${key}=`;
  if (a.startsWith(prefix)) {
    opts[key] = a.slice(prefix.length);
    return i;
  }
  const v = argv[i + 1];
  if (v == null) throw new Error(`--${key} requires a value`);
  opts[key] = v;
  return i + 1;
}

function validateOpts(opts) {
  if (opts.changed && opts.paths.length > 0) {
    throw new Error('--changed cannot be combined with explicit paths');
  }
}

function parseThreshold(threshold) {
  if (threshold === undefined) return DEFAULT_THRESHOLD;
  const n = Number(threshold);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`Invalid threshold: ${threshold}`);
  }
  return n;
}

function maxCrap(metrics) {
  let max = 0;
  for (const m of metrics) {
    if (m.crapScore != null && m.crapScore > max) max = m.crapScore;
  }
  return max;
}

const FAIL = Symbol('fail');

function main(argv, streams = {}) {
  const ctx = context(streams);

  const opts = tryStep(ctx, () => parseArgs(argv));
  if (opts === FAIL) {
    ctx.out.write(usage());
    return 1;
  }
  if (opts.help) {
    ctx.out.write(usage());
    return 0;
  }
  return runWithOpts(opts, ctx);
}

function runWithOpts(opts, ctx) {
  if (opts.runTests && tryStep(ctx, () => runTests(ctx.cwd)) === FAIL) return 1;
  const files = tryStep(ctx, () => resolveFiles(opts, ctx.cwd));
  if (files === FAIL) return 1;
  if (files.length === 0) {
    ctx.out.write('No JavaScript files to analyze.\n');
    return 0;
  }
  const coveragePath = resolveCoveragePath(opts, ctx.cwd);
  const result = tryStep(ctx, () =>
    analyze({ filePaths: files, coveragePath, projectRoot: ctx.cwd }),
  );
  if (result === FAIL) return 1;
  const { metrics, parseFailures } = result;
  ctx.out.write(
    formatReport(metrics, { threshold: opts.thresholdValue, parseFailures }),
  );
  return reportVerdict(metrics, opts.thresholdValue, ctx);
}

function resolveCoveragePath(opts, cwd) {
  return opts.coverage
    ? path.resolve(cwd, opts.coverage)
    : path.join(cwd, DEFAULT_COVERAGE);
}

function context(streams) {
  return {
    out: streams.out || process.stdout,
    err: streams.err || process.stderr,
    cwd: streams.cwd || process.cwd(),
  };
}

function tryStep(ctx, fn) {
  try {
    return fn();
  } catch (e) {
    ctx.err.write(e.message + '\n');
    return FAIL;
  }
}

function resolveFiles(opts, cwd) {
  if (opts.changed) return changedFiles(cwd);
  if (opts.paths.length > 0) return expandPaths(opts.paths, cwd);
  return findSourceFiles(cwd);
}

function reportVerdict(metrics, threshold, ctx) {
  const max = maxCrap(metrics);
  if (max > threshold) {
    ctx.err.write(
      `CRAP threshold exceeded: ${max.toFixed(1)} > ${threshold.toFixed(1)}\n`,
    );
    return 2;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

export { main, parseArgs, usage };
