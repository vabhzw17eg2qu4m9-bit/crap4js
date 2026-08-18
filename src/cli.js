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
//   crap4js profile [...]    Run instrumented tests and report per-function timing.
//   crap4js file-naming [...]  Flag mechanical file names (generic/numeric stems).
//   crap4js nesting [...]    Fail functions nested deeper than 5 levels.
//   crap4js class-size [...]  Fail god classes (>25 methods or WMC > 80).
//   crap4js weight-of-class [...]  Fail data-heavy classes (fields ratio > 0.33).
//   crap4js unused-code [...]  Flag module-private declarations never referenced.
//   crap4js unused-files [...]  Flag source files never imported.
//   crap4js banned-imports [--from G --forbid G --message M]... [paths...]
//                            Enforce architectural import boundaries.
//   crap4js magic-constants [paths...]
//                            Flag hex colors outside constants and literals
//                            repeated 3+ times per file.
//   crap4js test-assertions [paths...]
//                            Flag test() bodies with zero assertion calls.
//   crap4js folder-structure Flag src/ dirs with loose (direct) files.
//   crap4js skill            Print the crap4js profiling skill for AI agents.
//
// The first argument selects a subcommand when it is exactly `profile`,
// `file-naming`, `nesting`, `class-size`, `weight-of-class`, `unused-code`,
// `unused-files`, `banned-imports`, `magic-constants`,
// `test-assertions`, `folder-structure`, or `skill`;
// anything else is analyzed as before.
//
// Exit codes: 0 success; 1 usage error; 2 CRAP/profile threshold exceeded
// or gate-check violations.

import path from 'node:path';
import { analyze } from './analyzer.js';
import { formatReport } from './report.js';
import { changedFiles, expandPaths, findSourceFiles } from './files.js';
import { runTests } from './runtests.js';
import { runFileNaming } from './fileNaming.js';
import { runNesting } from './nesting.js';
import { runClassSize } from './classSize.js';
import { runWeightOfClass } from './weightOfClass.js';
import { runUnusedCode } from './unusedCode.js';
import { runUnusedFiles } from './unusedFiles.js';
import { runBannedImports } from './bannedImports.js';
import { runMagicConstants } from './magicConstants.js';
import { runTestAssertions } from './testAssertions.js';
import { runFolderStructure } from './folderStructure.js';
import { parseProfileArgs, runProfile } from './profile.js';
import { runSkill } from './skill.js';

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
    '  crap4js profile [--name <p>] [--threshold <ms>] [--top <N>] [paths...]',
    '                           Run instrumented tests and report per-function timing',
    '  crap4js file-naming [paths...]',
    '                           Flag mechanical file names (generic/numeric stems)',
    '  crap4js nesting [paths...]',
    '                           Fail functions whose control-flow nesting exceeds 5',
    '  crap4js class-size [paths...]',
    '                           Fail classes with >25 methods or WMC >80',
    '  crap4js weight-of-class [paths...]',
    '                           Fail classes whose public-instance field ratio exceeds 0.33',
    '  crap4js unused-code [paths...]',
    '                           Flag module-private declarations never referenced',
    '  crap4js unused-files [paths...]',
    '                           Flag source files never imported by analyzed sources',
    '  crap4js banned-imports [--from GLOB --forbid GLOB --message MSG]... [paths...]',
    '                           Enforce architectural import boundaries',
    '  crap4js magic-constants [paths...]',
    '                           Flag hex colors outside constants and literals',
    '                           repeated 3+ times in one file',
    '  crap4js test-assertions [paths...]',
    '                           Flag test()/it() bodies with zero assertion calls',
    '  crap4js folder-structure',
    '                           Flag src/ directories with loose direct files',
    '  crap4js skill            Print the crap4js profiling skill for AI agents',
    '',
  ].join('\n');
}

// Subcommand dispatch on the FIRST argument only. Each command parses its
// own flags, prints via ctx, and returns its exit code.
const SUBCOMMANDS = {
  profile: (args, ctx) => runProfile(parseProfileArgs(args), ctx),
  'file-naming': (args, ctx) => runFileNaming(args, ctx),
  nesting: (args, ctx) => runNesting(args, ctx),
  'class-size': (args, ctx) => runClassSize(args, ctx),
  'weight-of-class': (args, ctx) => runWeightOfClass(args, ctx),
  'unused-code': (args, ctx) => runUnusedCode(args, ctx),
  'unused-files': (args, ctx) => runUnusedFiles(args, ctx),
  'banned-imports': (args, ctx) => runBannedImports(args, ctx),
  'magic-constants': (args, ctx) => runMagicConstants(args, ctx),
  'test-assertions': (args, ctx) => runTestAssertions(args, ctx),
  'folder-structure': (args, ctx) => runFolderStructure(args, ctx),
  skill: (_args, ctx) => runSkill(ctx),
};

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

  const sub = dispatchSubcommand(argv, ctx);
  if (sub !== null) return sub;

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

// Runs the subcommand named by argv[0] when there is one; returns null when
// the first argument is a flag/path and the analyze path should take over.
function dispatchSubcommand(argv, ctx) {
  const run = SUBCOMMANDS[argv[0]];
  if (!run) return null;
  const code = tryStep(ctx, () => run(argv.slice(1), ctx));
  return code === FAIL ? 1 : code;
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
