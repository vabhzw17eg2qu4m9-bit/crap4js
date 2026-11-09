#!/usr/bin/env node
// crap4js CLI entry point.
//
// Usage:
//   crap4js                  Analyze all .js/.jsx/.ts/.tsx/.mjs/.cjs under src/.
//   crap4js --changed        Analyze git-changed files under src/.
//   crap4js <path>...        Analyze explicit files / directories.
//   crap4js --help           Print this help and exit 0.
//   crap4js --coverage <p>   Override coverage file (default coverage/coverage-final.json);
//                            a path ending in .info parses as an lcov tracefile;
//                            a missing, unparseable, or record-free coverage
//                            file fails the run (exit 1) — unit-test coverage
//                            is required.
//   crap4js --threshold <n>  Override CRAP threshold (default 8.0).
//   crap4js --metric <m>     Complexity metric: cyclomatic (default) | cognitive.
//   crap4js --run-tests      Run `nyc node --test` before analyzing.
//   crap4js --diff-base REF  Analyze only functions touched by the diff vs REF.
//   crap4js --strict         Files with no coverage entry are 0.0% covered
//                            (not N/A); explicit paths must exist.
//   crap4js --exclude GLOB   Skip files matching GLOB (project-relative, repeatable).
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
//   crap4js duplicates [--threshold N] [--min-tokens N] [--min-lines N]
//                      [--report percentage|clones] [--ignore-locals]
//                      [--ignore-literals] [--ignore-identifiers]
//                      [--ignore-imports] [--skip-duplicate-files]
//                      [--exclude GLOB]... [--source PATH]... [paths...]
//                            Flag duplicated token windows within/across
//                            files; the ignore flags opt into renamed-clone
//                            and literal masking, clones mode reports one
//                            violation per clone group.
//   crap4js similarity [--format console|json] [--jaccard N]
//                      [--containment N] [--min-shingles N]
//                      [--include GLOB]... [--exclude GLOB]... [paths...]
//                            Scan for near-duplicate files (docs, code)
//                            and print the similarity clusters;
//                            informational — always exits 0.
//   crap4js test-assertions [paths...]
//                            Flag test() bodies with zero assertion calls.
//   crap4js inline-anon-types [--max-fields N] [paths...]
//                            Flag inline anonymous type literals
//                            ({...} / [...]) in function signature
//                            annotations, incl. nested in type arguments;
//                            no-op on plain .js (no type syntax there).
//   crap4js folder-structure [--dir GLOB]... [--max-loose-files N]
//                      [--cap PATTERN:N]... [--exclude GLOB]...
//                            Flag directories holding more than their cap
//                            of loose (direct) source files; --cap gives
//                            per-pattern caps (first pattern wins)
//   crap4js mutation [...]  Mutation-test one operator/literal at a time.
//   crap4js reorder [--dry-run] [paths...]
//                            Rewrite class members into the canonical
//                            order (deterministic; same-kind order kept).
//   crap4js string-hazards [--severity warning|error] [paths...]
//                            Flag escaped template interpolations, RegExp
//                            escaped anchors, and ^/$ anchors in literal
//                            String patterns (replace/replaceAll/split).
//   crap4js identical-branches [--severity warning|error] [paths...]
//                            Flag the copy-paste-edit family: duplicate
//                            conditions/bodies in one if/else-if chain,
//                            duplicate operands in one &&/|| chain,
//                            identical ternary branches, duplicate
//                            positional call arguments, duplicate
//                            catch/finally bodies (canonical form).
//   crap4js collapsible-flow [--severity warning|error] [paths...]
//                            Flag control-flow nesting a mechanical
//                            rewrite can flatten (merge nested ifs,
//                            drop redundant else; chain hints).
//   crap4js non-null-assertion [--severity warning|error] [paths...]
//                            Flag every TS non-null assertion (x!,
//                            obj['k']!, chains) in .ts/.tsx — a bang
//                            crashes on null; ?. / ?? carry the same
//                            intent with a readable check.
//   crap4js loc [--max-lines N] [--exclude GLOB]... [paths...]
//                            Fail files longer than N lines (default 800).
//   crap4js method-size [--max-lines N] [--max-params N] [paths...]
//                            Fail methods longer than N body lines
//                            (default 60) or with more than N params
//                            (default 6); constructors checked for
//                            params only.
//   crap4js public-docs [--exclude GLOB]... [paths...]
//                            Fail exported functions/classes and methods
//                            of exported classes lacking JSDoc.
//   crap4js test-coverage [--min-percent F] [--coverage PATH]
//                      [--exclude GLOB]... [paths...]
//                            Fail when total statement coverage of the
//                            selection is below F% (default 80.0);
//                            missing/empty coverage input exits 1.
//   crap4js complexity [--metric cyclomatic|cognitive] [--max N] [paths...]
//                            Fail functions whose complexity (CC or
//                            cognitive) exceeds N (default 10).
//   crap4js skill            Print the crap4js profiling skill for AI agents.
//
// The first argument selects a subcommand when it is exactly `profile`,
// `file-naming`, `nesting`, `class-size`, `weight-of-class`, `unused-code`,
// `unused-files`, `banned-imports`, `magic-constants`, `scattered-constants`,
// `duplicates`, `similarity`, `test-assertions`, `inline-anon-types`,
// `folder-structure`, `mutation`, `reorder`, `string-hazards`,
// `identical-branches`, `collapsible-flow`, `non-null-assertion`, `loc`,
// `method-size`, `public-docs`, `test-coverage`, `complexity`, `memory`,
// or `skill`;
// anything else is analyzed as before.
//
// Exit codes: 0 success; 1 usage error; 2 CRAP/profile threshold exceeded
// or gate-check violations.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { analyze } from './analyzer.js';
import { formatReport } from './report.js';
import { changedFiles, expandPaths, findSourceFiles, toRelPath } from './files.js';
import { gitChangedLines } from './diffLines.js';
import { globToRegExp } from './bannedImports.js';
import { runTests } from './runtests.js';
import { runFileNaming } from './fileNaming.js';
import { runNesting } from './nesting.js';
import { runClassSize } from './classSize.js';
import { runWeightOfClass } from './weightOfClass.js';
import { runUnusedCode } from './unusedCode.js';
import { runUnusedFiles } from './unusedFiles.js';
import { runBannedImports } from './bannedImports.js';
import { runMagicConstants } from './magicConstants.js';
import { runScatteredConstants } from './scatteredConstants.js';
import { runDuplicates } from './duplicates.js';
import { runSimilarity } from './similarity.js';
import { runTestAssertions } from './testAssertions.js';
import { runInlineAnonTypes } from './inlineAnonTypes.js';
import { runFolderStructure } from './folderStructure.js';
import { runMutation } from './mutation.js';
import { runReorder } from './reorder.js';
import { runStringHazards } from './stringHazards.js';
import { runIdenticalBranches } from './identicalBranches.js';
import { runCollapsibleFlow } from './collapsibleFlow.js';
import { runNonNullAssertion } from './nonNullAssertion.js';
import { runLoc } from './loc.js';
import { runMethodSize } from './methodSize.js';
import { runPublicDocs } from './publicDocs.js';
import { runTestCoverage } from './testCoverage.js';
import { runComplexity } from './complexity.js';
import { parseProfileArgs, runProfile } from './profile.js';
import { runMemory } from './memory.js';
import { runSkill } from './skill.js';
import { isMain } from './mainGuard.js';
import { COGNITIVE } from './complexity.js';
import { COVERAGE, DEFAULT_COVERAGE, EXCLUDE, THRESHOLD_FLAG } from './constants.js';

const DEFAULT_THRESHOLD = 8.0;
const METRICS = new Set(['cyclomatic', COGNITIVE]);

function usage() {
  return [
    'Usage:',
    '  crap4js                  Analyze all .js/.jsx/.ts/.tsx/.mjs/.cjs files under src/',
    '  crap4js --changed        Analyze git-changed source files under src/',
    '  crap4js <path>...        Analyze explicit files / directories (expanded)',
    '  crap4js --help           Print this help message',
    '  crap4js --coverage <p>   Override coverage file (default: ' + DEFAULT_COVERAGE + ')',
    '                           A missing, unparseable, or record-free coverage',
    '                           file fails the run (exit 1): unit-test coverage',
    '                           is required. Generate it with',
    '                           `npx c8 --reporter=json node --test`',
    '  crap4js --threshold <n>  Override CRAP threshold (default: ' + DEFAULT_THRESHOLD + ')',
    '  crap4js --metric <m>     Complexity metric: cyclomatic (default) or cognitive;',
    '                           the chosen value feeds the CRAP formula',
    '  crap4js --run-tests      Run the test+coverage suite before analyzing',
    '  crap4js --coverage <p>   A path ending in .info parses as an lcov',
    '                           tracefile instead of Istanbul JSON',
    '  crap4js --diff-base REF  Analyze only the functions intersecting lines',
    '                           added/changed vs git ref REF (renames use the',
    '                           new path; explicit paths scope the diff;',
    '                           mutually exclusive with --changed)',
    '  crap4js --strict         Selected files with no coverage entry count as',
    '                           0.0% covered instead of N/A, and explicit',
    '                           paths must exist (exit 1 otherwise)',
    '  crap4js --exclude GLOB   Skip files whose project-relative path matches',
    '                           GLOB (repeatable)',
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
    '                           repeated 3+ times per file.',
    '  crap4js scattered-constants [--min-files N] [--min-length N]',
    '                     [--min-value N] [--ignore VALUE]... [--exclude GLOB]...',
    '                     [--aliases|--no-aliases] [paths...]',
    '                           Flag literals whose value repeats across',
    '                           distinct files: existing const declarations',
    '                           regress immediately, scattered values need',
    '                           --min-files files; private const _x = kY;',
    '                           pure aliases are flagged (--no-aliases opts',
    '                           out).',
    '  crap4js duplicates [--threshold N] [--min-tokens N] [--min-lines N]',
    '                     [--report percentage|clones] [--ignore-locals]',
    '                     [--ignore-literals] [--ignore-identifiers]',
    '                     [--ignore-imports] [--skip-duplicate-files]',
    '                     [--exclude GLOB]... [--source PATH]... [paths...]',
    '                           Flag duplicated token windows within/across',
    '                           files; the ignore flags opt into renamed-clone',
    '                           and literal masking, clones mode reports one',
    '                           violation per clone group',
    '  crap4js test-assertions [paths...]',
    '                           Flag test()/it() bodies with zero assertion calls',
    '  crap4js inline-anon-types [--max-fields N] [paths...]',
    '                           Flag inline anonymous type literals ({...}',
    '                           / [...]) in function signature annotations,',
    '                           incl. nested in type arguments; plain .js',
    '                           has no type syntax, so it is a no-op there',
    '  crap4js folder-structure [--dir GLOB]... [--max-loose-files N]',
    '                      [--cap PATTERN:N]... [--exclude GLOB]...',
    '                           Flag directories holding more than their',
    '                           cap of loose (direct) source files; --cap',
    '                           gives per-pattern caps (first pattern wins)',
    '  crap4js mutation [--min-score N] [--max-survivors N]',
    '                   [--timeout-seconds N] [--max-mutants N]',
    '                   [--cache|--no-cache] [--test-args ARG]...',
    '                   [--diff-base REF] [--scope-tests]',
    '                   [--operators CAT]... [--exclude GLOB]... [paths...]',
    '                           Mutate one operator/literal at a time and',
    '                           re-run the test suite (node --test) per',
    '                           mutant; covered sites only, survivors flagged.',
    '                           Killed mutants of unchanged methods are',
    '                           replayed from .crap-mutation-cache.json',
    '                           (--no-cache disables); --test-args scopes',
    '                           the per-mutant suite; --diff-base executes',
    '                           only the mutants of methods changed vs REF;',
    '                           --scope-tests narrows each mutant to its',
    "                           file's derived test files (scoped kills cache",
    '                           as kills; survivors are re-confirmed against',
    '                           the full suite)',
    '  crap4js reorder [--dry-run] [paths...]',
    '                           Rewrite class members into the canonical',
    '                           order (static fields, instance fields,',
    '                           constructor, static methods, getters/',
    '                           setters, public methods, private #methods;',
    '                           same-kind order kept). Comments above a',
    '                           member move with it. --dry-run lists the',
    '                           files that would change and exits 2.',
    '  crap4js memory [--top N] [--format console|json] [--badge PATH]',
    '                  [--badge-threshold MB] [paths...]',
    '                           Run the test suite under node --trace-gc (one',
    '                           file per sequential child run) and report',
    '                           per-test allocation churn and heap growth.',
    '                           --badge writes a shields-style churn SVG.',
    '                           Informational — always exits 0.',
    '  crap4js string-hazards [--severity warning|error] [paths...]',
    '                           Flag string literals whose escaping or',
    '                           pattern usage contradicts the intent:',
    '                           escaped template interpolations (\\${name}',
    '                           with sibling ${name} evidence), RegExp',
    '                           sources with an escaped anchor (/...\\$/)',
    '                           and ^/$ anchors in STRING patterns of',
    '                           replace/replaceAll/split. Warning by',
    '                           default — findings exit 0; --severity',
    '                           error exits 2.',
    '  crap4js identical-branches [--severity warning|error] [paths...]',
    '                           Flag the copy-paste-edit bug family —',
    '                           duplicate conditions/branch bodies in one',
    '                           if/else-if chain, duplicate operands in',
    '                           one &&/|| chain (absorption included),',
    '                           identical ternary branches, duplicate',
    '                           positional call arguments, duplicate',
    '                           catch/finally bodies — all compared by',
    '                           canonical form. Warning by default —',
    '                           findings exit 0; --severity error exits 2.',
    '  crap4js collapsible-flow [--severity warning|error] [paths...]',
    '                           Flag control-flow nesting a mechanical',
    '                           rewrite can flatten: nested if without',
    '                           else merging into one && condition,',
    '                           redundant else after an always-exiting',
    '                           then branch, and else-if chains after a',
    '                           terminal then (hint only). Warning by',
    '                           default — findings exit 0; --severity',
    '                           error exits 2.',
    '  crap4js non-null-assertion [--severity warning|error] [paths...]',
    '                           Flag every TS non-null assertion (x!,',
    "                           obj['k']!, chains) in .ts/.tsx files —",
    '                           a bang crashes on null; ?. / ?? carry',
    '                           the same intent with a readable',
    '                           check. Warning by default — findings',
    '                           exit 0; --severity error exits 2.',
    '  crap4js loc [--max-lines N] [--exclude GLOB]... [paths...]',
    '                           Fail files longer than N lines (default',
    '                           800); --exclude drops files from the',
    '                           check entirely.',
    '  crap4js method-size [--max-lines N] [--max-params N] [paths...]',
    '                           Fail methods longer than N body lines',
    '                           (default 60) or with more than N params',
    '                           (default 6); constructors are checked',
    '                           for the parameter count only.',
    '  crap4js public-docs [--exclude GLOB]... [paths...]',
    '                           Fail exported functions/classes and the',
    '                           public methods of exported classes',
    '                           lacking an adjacent /** */ JSDoc block.',
    '  crap4js test-coverage [--min-percent F] [--coverage PATH]',
    '                      [--exclude GLOB]... [paths...]',
    '                           Fail when the total statement coverage',
    '                           of the selection (from the CRAP coverage',
    '                           input, Istanbul JSON or lcov .info) is',
    '                           below F% (default 80.0); a missing or',
    '                           empty coverage input fails (exit 1).',
    '  crap4js complexity [--metric cyclomatic|cognitive] [--max N] [paths...]',
    '                           Fail functions whose complexity exceeds',
    '                           N (default 10): the cyclomatic path',
    '                           count (CC) by default, or the cognitive',
    '                           score with --metric cognitive.',
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
  'scattered-constants': (args, ctx) => runScatteredConstants(args, ctx),
  duplicates: (args, ctx) => runDuplicates(args, ctx),
  similarity: (args, ctx) => runSimilarity(args, ctx),
  'test-assertions': (args, ctx) => runTestAssertions(args, ctx),
  'inline-anon-types': (args, ctx) => runInlineAnonTypes(args, ctx),
  'folder-structure': (args, ctx) => runFolderStructure(args, ctx),
  mutation: (args, ctx) => runMutation(args, ctx),
  reorder: (args, ctx) => runReorder(args, ctx),
  'string-hazards': (args, ctx) => runStringHazards(args, ctx),
  'identical-branches': (args, ctx) => runIdenticalBranches(args, ctx),
  'collapsible-flow': (args, ctx) => runCollapsibleFlow(args, ctx),
  'non-null-assertion': (args, ctx) => runNonNullAssertion(args, ctx),
  loc: (args, ctx) => runLoc(args, ctx),
  'method-size': (args, ctx) => runMethodSize(args, ctx),
  'public-docs': (args, ctx) => runPublicDocs(args, ctx),
  'test-coverage': (args, ctx) => runTestCoverage(args, ctx),
  complexity: (args, ctx) => runComplexity(args, ctx),
  memory: (args, ctx) => runMemory(args, ctx),
  skill: (_args, ctx) => runSkill(ctx),
};

const SIMPLE_FLAGS = {
  '--help': 'help',
  '-h': 'help',
  '--changed': 'changed',
  '--run-tests': 'runTests',
  '--strict': 'strict',
};

function parseArgs(argv) {
  const opts = newOpts();
  for (let i = 0; i < argv.length; i++) {
    i = applyArg(opts, argv, i);
  }
  validateOpts(opts);
  opts.thresholdValue = parseThreshold(opts.threshold);
  opts.metricValue = parseMetric(opts.metric);
  return opts;
}

function newOpts() {
  return {
    paths: [],
    changed: false,
    help: false,
    coverage: undefined,
    threshold: undefined,
    metric: undefined,
    runTests: false,
    diffBase: undefined,
    strict: false,
    exclude: [],
  };
}

function applyArg(opts, argv, i) {
  const a = argv[i];
  const simple = SIMPLE_FLAGS[a];
  if (simple) {
    opts[simple] = true;
    return i;
  }
  if (isFlag(a, '--coverage')) return takeValue(opts, COVERAGE, a, argv, i);
  if (isFlag(a, THRESHOLD_FLAG)) return takeValue(opts, 'threshold', a, argv, i);
  if (isFlag(a, '--metric')) return takeValue(opts, 'metric', a, argv, i);
  if (isFlag(a, '--diff-base')) return takeValue(opts, 'diffBase', a, argv, i);
  if (isFlag(a, '--exclude')) return takeValue(opts, EXCLUDE, a, argv, i, true);
  if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
  opts.paths.push(a);
  return i;
}

function isFlag(a, flag) {
  return a === flag || a.startsWith(flag + '=');
}

function takeValue(opts, key, a, argv, i, append = false) {
  const prefix = `--${key}=`;
  const inline = a.startsWith(prefix);
  const v = inline ? a.slice(prefix.length) : argv[i + 1];
  if (v == null) throw new Error(`--${key} requires a value`);
  if (append) {
    (opts[key] ??= []).push(v);
  } else {
    opts[key] = v;
  }
  return inline ? i : i + 1;
}

function validateOpts(opts) {
  if (opts.changed && opts.paths.length > 0) {
    throw new Error('--changed cannot be combined with explicit paths');
  }
  if (opts.diffBase !== undefined && opts.changed) {
    throw new Error('--diff-base cannot be combined with --changed');
  }
  if (opts.diffBase !== undefined && opts.diffBase.trim() === '') {
    throw new Error('--diff-base requires a non-empty git ref');
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

function parseMetric(metric) {
  if (metric === undefined) return 'cyclomatic';
  if (!METRICS.has(metric)) throw new Error(`Invalid metric: ${metric}`);
  return metric;
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
  const inputs = resolveRunInputs(opts, ctx);
  if (inputs === null) return 1;
  if (inputs.files.length === 0) return 0;
  const coveragePath = resolveCoveragePath(opts, ctx.cwd);
  const result = tryStep(ctx, () =>
    analyze({ filePaths: inputs.files, coveragePath, projectRoot: ctx.cwd, metric: opts.metricValue, strict: opts.strict, diffLines: inputs.diffLines }),
  );
  if (result === FAIL) return 1;
  if (isEmptyDiffSelection(inputs.diffLines, result.metrics)) {
    // The diff touched no function body in the selection: nothing to analyze.
    ctx.out.write('No JavaScript files to analyze.\n');
    return 0;
  }
  ctx.out.write(
    formatReport(result.metrics, {
      threshold: opts.thresholdValue,
      parseFailures: result.parseFailures,
      metric: opts.metricValue,
    }),
  );
  return reportVerdict(result.metrics, opts.thresholdValue, ctx);
}

// File selection plus the --diff-base changed-line map. Writes the empty
// selection message itself and returns `files: []`; returns null on failure
// (the error message is already written). A git failure under --diff-base
// throws inside tryStep and surfaces as a usage error (exit 1).
function resolveRunInputs(opts, ctx) {
  const files = tryStep(ctx, () => resolveFiles(opts, ctx.cwd));
  if (files === FAIL) return null;
  if (files.length === 0) {
    ctx.out.write('No JavaScript files to analyze.\n');
    return { files: [], diffLines: null };
  }
  const diffLines = tryStep(ctx, () => diffLinesFor(opts, files, ctx.cwd));
  if (diffLines === FAIL) return null;
  return { files, diffLines };
}

// Changed-line map for --diff-base runs; null without the flag.
function diffLinesFor(opts, files, cwd) {
  if (opts.diffBase === undefined || files.length === 0) return null;
  return gitChangedLines(opts.diffBase, files.map((f) => toRelPath(f, cwd)), cwd);
}

// A --diff-base run whose selection kept no function analyzes nothing.
function isEmptyDiffSelection(diffLines, metrics) {
  return diffLines !== null && metrics.length === 0;
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
  let files;
  if (opts.changed) {
    files = changedFiles(cwd);
  } else if (opts.paths.length > 0) {
    if (opts.strict) {
      for (const p of opts.paths) {
        if (!existsSync(path.resolve(cwd, p))) throw new Error(`path does not exist: ${p}`);
      }
    }
    files = expandPaths(opts.paths, cwd);
  } else {
    files = findSourceFiles(cwd);
  }
  if (opts.exclude.length === 0) return files;
  const globs = opts.exclude.map(globToRegExp);
  return files.filter((f) => !globs.some((g) => g.test(toRelPath(f, cwd))));
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

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));

export { main, parseArgs, usage };
