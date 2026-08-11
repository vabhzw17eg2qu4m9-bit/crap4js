#!/usr/bin/env node
// crap4js CLI entry point.
//
// Usage:
//   crap4js                  Analyze all .js/.mjs/.cjs under src/.
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
    '  crap4js                  Analyze all .js/.mjs/.cjs files under src/',
    '  crap4js --changed        Analyze git-changed source files under src/',
    '  crap4js <path>...        Analyze explicit files / directories (expanded)',
    '  crap4js --help           Print this help message',
    '  crap4js --coverage <p>   Override coverage file (default: ' + DEFAULT_COVERAGE + ')',
    '  crap4js --threshold <n>  Override CRAP threshold (default: ' + DEFAULT_THRESHOLD + ')',
    '  crap4js --run-tests      Run the test+coverage suite before analyzing',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    paths: [],
    changed: false,
    help: false,
    coverage: undefined,
    threshold: undefined,
    runTests: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--changed') {
      opts.changed = true;
    } else if (a === '--run-tests') {
      opts.runTests = true;
    } else if (a === '--coverage') {
      const v = argv[++i];
      if (v == null) throw new Error('--coverage requires a value');
      opts.coverage = v;
    } else if (a.startsWith('--coverage=')) {
      opts.coverage = a.slice('--coverage='.length);
    } else if (a === '--threshold') {
      const v = argv[++i];
      if (v == null) throw new Error('--threshold requires a value');
      opts.threshold = v;
    } else if (a.startsWith('--threshold=')) {
      opts.threshold = a.slice('--threshold='.length);
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      opts.paths.push(a);
    }
  }
  if (opts.changed && opts.paths.length > 0) {
    throw new Error('--changed cannot be combined with explicit paths');
  }
  let thresholdValue = DEFAULT_THRESHOLD;
  if (opts.threshold !== undefined) {
    const n = Number(opts.threshold);
    if (Number.isNaN(n) || n < 0) {
      throw new Error(`Invalid threshold: ${opts.threshold}`);
    }
    thresholdValue = n;
  }
  opts.thresholdValue = thresholdValue;
  return opts;
}

function maxCrap(metrics) {
  let max = 0;
  for (const m of metrics) {
    if (m.crapScore != null && m.crapScore > max) max = m.crapScore;
  }
  return max;
}

function main(argv, streams = {}) {
  const out = streams.out || process.stdout;
  const err = streams.err || process.stderr;
  const cwd = streams.cwd || process.cwd();

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err.write(e.message + '\n');
    out.write(usage());
    return 1;
  }

  if (opts.help) {
    out.write(usage());
    return 0;
  }

  if (opts.runTests) {
    try {
      runTests(cwd);
    } catch (e) {
      err.write(e.message + '\n');
      return 1;
    }
  }

  let files;
  try {
    if (opts.changed) files = changedFiles(cwd);
    else if (opts.paths.length > 0) files = expandPaths(opts.paths, cwd);
    else files = findSourceFiles(cwd);
  } catch (e) {
    err.write(e.message + '\n');
    return 1;
  }

  if (files.length === 0) {
    out.write('No JavaScript files to analyze.\n');
    return 0;
  }

  const coveragePath = opts.coverage
    ? path.resolve(cwd, opts.coverage)
    : path.join(cwd, DEFAULT_COVERAGE);

  let metrics;
  try {
    metrics = analyze({ filePaths: files, coveragePath, projectRoot: cwd });
  } catch (e) {
    err.write(e.message + '\n');
    return 1;
  }

  out.write(formatReport(metrics, { threshold: opts.thresholdValue }));

  const max = maxCrap(metrics);
  if (max > opts.thresholdValue) {
    err.write(
      `CRAP threshold exceeded: ${max.toFixed(1)} > ${opts.thresholdValue.toFixed(1)}\n`,
    );
    return 2;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

export { main, parseArgs, usage };
