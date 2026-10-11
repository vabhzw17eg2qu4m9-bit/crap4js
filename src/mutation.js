// `mutation` subcommand: mutation testing, port of crap4dart c865ec3's
// mutation gate (spec §11.22), adapted from the unclebob/mutator research
// conclusions. A declarative, category-tagged operator table is matched on
// the parsed babel AST — every span comes from node/token offsets, never
// regex. Sites in unexecuted code (Istanbul coverage) are `uncovered` and
// excluded from the score denominator; every covered site is mutated one
// at a time and the project's test suite re-runs per mutant (`node
// --test`, the analog of upstream's `dart test`) — a
// non-zero exit kills the mutant (a module-load failure plays the Dart
// compile-error role: the suite refuses to run), a clean pass means the
// mutant survived, and a timeout counts as survived because the suite did
// not kill it deterministically. The file is restored after every mutant;
// an end-of-run tree integrity check (crap4dart 8b2e8e8) snapshots every
// file before the loop and re-verifies the whole tree in an outer finally
// — drift (an out-of-band write defeating the per-site restore) is
// re-restored and surfaced as an INTEGRITY violation.
//
// Expensive — the test suite runs once per mutant — so like every gate
// here it only runs when invoked as the `mutation` subcommand (upstream:
// disabled by default). The digest-incremental cache (crap4dart 16d9c4c,
// src/mutationCache.js) replays killed mutants of unchanged methods so
// repeat runs cost only the survivors; `--no-cache` opts out,
// `--test-args` scopes the per-mutant suite.
//
// Dart-only rows adapted to JS: `/` → `%` (upstream `/` → `~/`, Dart's
// integer division), and `===`/`!==` join `==`/`!=` as equality rows.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { childrenOf, extractMethodsWithNodes, isNode, parseTokenized } from './complexity.js';
import { loadCoverage } from './coverage.js';
import { globToRegExp } from './bannedImports.js';
import { gateFiles, isTestPath, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { MUTATION_CACHE_FILE_NAME, MutationCache, cacheMetaCurrent, fnv1a64Hex, methodsKey } from './mutationCache.js';

const DEFAULT_MIN_SCORE = 0.8;
const DEFAULT_MAX_SURVIVORS = 0;
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_MUTANTS = 500;
const DEFAULT_COVERAGE = 'coverage/coverage-final.json';
// The per-mutant suite invocation (`node <testArgs...>`), the analog of
// upstream's `test_args` default `['test']` for `dart test`.
const DEFAULT_TEST_ARGS = ['--test'];
const DEFAULT_CACHE = true;

// Operator categories of the `mutation` gate, in stable order (upstream
// `mutationOperatorCategories`). `--operators` accepts any subset.
export const OPERATOR_CATEGORIES = [
  'arithmetic',
  'boundary',
  'equality',
  'logical',
  'boolean',
  'constant',
  'unary',
];

// The declarative operator table (unclebob/mutator adaptation):
// `[category, original, mutant]`. Binary rows match
// BinaryExpression/LogicalExpression operator lexemes; the constant row
// fires on `-1` prefixes too; literal rows match boolean/numeric literal
// lexemes. One row = one mutant, so `/` produces two sites.
const CONSTANT_CATEGORY = 'constant';
const OPERATORS = [
  ['arithmetic', '+', '-'],
  ['arithmetic', '-', '+'],
  ['arithmetic', '*', '/'],
  ['arithmetic', '/', '*'],
  ['arithmetic', '/', '%'],
  ['boundary', '>', '>='],
  ['boundary', '>=', '>'],
  ['boundary', '<', '<='],
  ['boundary', '<=', '<'],
  ['boundary', '>', '<'],
  ['boundary', '<', '>'],
  ['boundary', '>=', '<='],
  ['boundary', '<=', '>='],
  ['equality', '==', '!='],
  ['equality', '!=', '=='],
  ['equality', '===', '!=='],
  ['equality', '!==', '==='],
  ['logical', '&&', '||'],
  ['logical', '||', '&&'],
  ['boolean', 'true', 'false'],
  ['boolean', 'false', 'true'],
  ['constant', '0', '1'],
  ['constant', '1', '0'],
];

// Mutant verdicts: non-zero test exit kills (module-load failures
// included), a clean pass survives, a timeout survives.
export const KILLED = 'killed';
export const SURVIVED = 'survived';
export const TIMEOUT = 'timeout';

// Thrown when the test command cannot be spawned at all; the gate turns
// this into a skipped result.
class MutationUnavailableError extends Error {}

// ---------------------------------------------------------------------------
// Site detection

/**
 * Detect mutation sites in one source file: rows of the operator table
 * matched on the parsed AST, spans from node/token offsets, sorted by
 * offset (the engine's deterministic order).
 *
 * @param {string} source
 * @param {string} ext  File extension routing flow vs typescript plugins.
 * @param {Iterable<string>} enabled  Enabled operator categories.
 * @returns {Array<object>} sites without file/method (filled by the gate).
 */
export function detectSites(source, ext, enabled = OPERATOR_CATEGORIES) {
  const { program, tokens } = parseTokenized(source, ext);
  const ctx = {
    source,
    tokens: tokens.filter(realToken),
    enabled: new Set(enabled),
  };
  const sites = [];
  visit(program, ctx, sites);
  return sites.sort((a, b) => a.offset - b.offset);
}

// Babel emits comments inside the token stream as bare strings; real
// tokens carry a type object (same skip as tokenizeSource).
function realToken(t) {
  return typeof t.type !== 'string' && t.type.label !== 'eof';
}

function visit(node, ctx, sites) {
  if (!isNode(node)) return;
  siteFor(node, ctx, sites);
  for (const child of childrenOf(node)) visit(child, ctx, sites);
}

// One AST node's sites, dispatched by type. Each matching table row
// appends exactly one site.
function siteFor(node, ctx, sites) {
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
    operatorSites(node, ctx, sites);
  } else if (node.type === 'UnaryExpression') {
    unarySites(node, ctx, sites);
  } else if (node.type === 'BooleanLiteral') {
    booleanSite(node, ctx, sites);
  } else if (node.type === 'NumericLiteral') {
    numericSite(node, ctx, sites);
  }
}

// Binary rows matching this node's operator. The AST owns the match; the
// token between the operands only supplies the exact replacement span.
function operatorSites(node, ctx, sites) {
  for (const [category, original, mutant] of OPERATORS) {
    if (original !== node.operator || !ctx.enabled.has(category)) continue;
    const span = operatorSpan(node, ctx);
    if (!span) continue;
    sites.push(site(span.line, span.offset, span.length, category, original, mutant));
  }
}

// The operator lexeme's span strictly between the operands. Exactly one
// such token exists for every matched operator.
function operatorSpan(node, ctx) {
  for (const t of ctx.tokens) {
    if (
      t.start >= node.left.end &&
      t.end <= node.right.start &&
      ctx.source.slice(t.start, t.end) === node.operator
    ) {
      return { offset: t.start, length: t.end - t.start, line: t.loc.start.line };
    }
  }
  return null;
}

// `!` is deleted (prefix only — the postfix TS non-null `!` would corrupt
// the operand); `-1` is replaced by `0` over the whole `-1` span. The `1`
// operand additionally yields its own constant site, like upstream.
function unarySites(node, ctx, sites) {
  if (!node.prefix) return;
  if (node.operator === '!' && ctx.enabled.has('unary')) {
    sites.push(site(node.loc.start.line, node.start, 1, 'unary', '!', ''));
  }
  if (node.operator === '-' && ctx.enabled.has(CONSTANT_CATEGORY) && lexeme(ctx, node.argument) === '1') {
    const length = node.end - node.start;
    sites.push(site(node.loc.start.line, node.start, length, CONSTANT_CATEGORY, '-1', '0'));
  }
}

function booleanSite(node, ctx, sites) {
  if (!ctx.enabled.has('boolean')) return;
  const lex = lexeme(ctx, node);
  sites.push(site(node.loc.start.line, node.start, node.end - node.start, 'boolean', lex, lex === 'true' ? 'false' : 'true'));
}

// Integer-literal rows: only the bare `0`/`1` lexemes flip (`0x0`,
// `1.0`, `1_000` keep their lexeme and never mutate).
function numericSite(node, ctx, sites) {
  const lex = lexeme(ctx, node);
  if (!ctx.enabled.has(CONSTANT_CATEGORY) || (lex !== '0' && lex !== '1')) return;
  sites.push(site(node.loc.start.line, node.start, node.end - node.start, CONSTANT_CATEGORY, lex, lex === '0' ? '1' : '0'));
}

function lexeme(ctx, node) {
  return ctx.source.slice(node.start, node.end);
}

function site(line, offset, length, category, original, mutant) {
  return { line, offset, length, category, original, mutant };
}

// ---------------------------------------------------------------------------
// Coverage gating

// Per-line max hit count from Istanbul statement coverage.
function lineHits(fileCoverage) {
  const hits = new Map();
  for (const [id, loc] of Object.entries(fileCoverage?.statementMap ?? {})) {
    const count = fileCoverage.s?.[id] ?? 0;
    for (let line = loc.start.line; line <= loc.end.line; line++) {
      if (count > (hits.get(line) ?? 0)) hits.set(line, count);
    }
  }
  return hits;
}

// Whether any covered line inside the method's range was executed.
function methodExecuted(method, hits) {
  for (const [line, count] of hits) {
    if (line >= method.startLine && line <= method.endLine && count > 0) return true;
  }
  return false;
}

// The method whose line range contains `line`, or null.
function containingMethod(methods, line) {
  return methods.find((m) => line >= m.startLine && line <= m.endLine) ?? null;
}

// A site is covered when its containing method was executed and the
// site's line is not recorded as unexecuted; sites outside every method
// fall back to raw line coverage.
function isCovered(site, hits, methods) {
  if (hits.size === 0) return false;
  const method = containingMethod(methods, site.line);
  if (!method) return (hits.get(site.line) ?? 0) > 0;
  return methodExecuted(method, hits) && (hits.get(site.line) ?? 1) > 0;
}

// ---------------------------------------------------------------------------
// Engine

/**
 * Applies single-token mutations one at a time and runs the project's
 * test command against each mutant, restoring the file afterwards (also
 * after timeouts and errors). With a cache session, mutants of unchanged
 * methods whose previous outcome was `killed` are replayed from the cache
 * (counted killed, marked `fromCache`); survivors are always re-executed,
 * and the merged cache is persisted after the run.
 *
 * Safety net (crap4dart 8b2e8e8): every file about to be mutated is
 * snapshotted before the loop and the whole tree is re-verified in an
 * outer finally — files that drifted (an out-of-band write defeating the
 * per-site restore) are re-restored and reported in
 * `integrityViolations`, even when the loop died mid-mutant.
 *
 * @returns {{outcomes: Array<{site, outcome, fromCache}>, integrityViolations: string[]}}
 */
export function runEngine(projectRoot, sites, timeoutMs, runner, caching = null) {
  const outcomes = [];
  const fresh = new Map();
  const originals = snapshotOriginals(sites);
  let integrityViolations = [];
  try {
    for (const site of sites) {
      const ref = caching?.siteMethods.get(site) ?? null;
      const replayed = ref ? caching.cache.replayKill(ref, site) : null;
      if (replayed) {
        outcomes.push({ site, outcome: KILLED, fromCache: true });
        accumulate(fresh, ref, replayed);
        continue;
      }
      const outcome = executeSite(projectRoot, site, timeoutMs, runner);
      outcomes.push({ site, outcome, fromCache: false });
      if (ref) accumulate(fresh, ref, cachedOutcome(site, outcome, ref));
    }
  } finally {
    integrityViolations = verifyIntegrity(originals);
  }
  persist(caching, fresh);
  return { outcomes, integrityViolations };
}

function executeSite(projectRoot, site, timeoutMs, runner) {
  const original = readFileSync(site.file, 'utf8');
  writeFileSync(site.file, original.slice(0, site.offset) + site.mutant + original.slice(site.offset + site.length));
  try {
    return runner(projectRoot, timeoutMs);
  } finally {
    // Always restore the file, also after timeouts and errors.
    writeFileSync(site.file, original);
  }
}

// Snapshots the current content of every file the sites touch.
function snapshotOriginals(sites) {
  const originals = new Map();
  for (const s of sites) {
    if (!originals.has(s.file)) originals.set(s.file, readFileSync(s.file, 'utf8'));
  }
  return originals;
}

// Restores any file whose on-disk content drifted from its snapshot;
// returns the paths that had to be re-restored (empty when healthy).
function verifyIntegrity(originals) {
  const violations = [];
  for (const [file, content] of originals) {
    if (readFileSync(file, 'utf8') !== content) {
      writeFileSync(file, content);
      violations.push(file);
    }
  }
  return violations;
}

// The cache record of one executed site: the offset is stored relative to
// the containing method's start (stable across edits elsewhere in the file).
function cachedOutcome(site, outcome, ref) {
  return {
    offset: site.offset - ref.start,
    line: site.line,
    category: site.category,
    original: site.original,
    mutant: site.mutant,
    status: outcome,
  };
}

function accumulate(fresh, ref, outcome) {
  const entry = fresh.get(ref.key) ?? { digest: ref.digest, outcomes: [] };
  entry.outcomes.push(outcome);
  fresh.set(ref.key, entry);
}

function persist(caching, fresh) {
  if (!caching) return;
  caching.cache.mergeRun(fresh, caching.liveKeys);
  caching.cache.save(caching.cacheFile);
}

// The per-mutant suite must never inherit this run's own test-runner
// context: under `node --test` the leaked child vars (NODE_TEST_CONTEXT,
// NODE_TEST_WORKER_ID) turn the nested runner into a fake test child that
// exits instantly — every mutant would look survived.
const RUNNER_ENV_VARS = /^(NODE_TEST_CONTEXT|NODE_TEST_WORKER_ID)$/;

function mutantEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!RUNNER_ENV_VARS.test(key)) env[key] = value;
  }
  return env;
}

/**
 * The default per-mutant runner: the platform test runner (`node --test`,
 * the JS analog of upstream's `dart test`) in the project root, killed on
 * timeout (spawnSync reports a killed child as `status === null`; the
 * timeout itself surfaces as error code ETIMEDOUT). Throws
 * MutationUnavailableError when the spawn itself fails. `testArgs` is the
 * full argument list of the invocation (default `['--test']`).
 */
export function runMutantTests(projectRoot, timeoutMs, spawn = spawnSync, testArgs = DEFAULT_TEST_ARGS) {
  const r = spawn(process.execPath, testArgs, {
    cwd: projectRoot,
    stdio: 'ignore',
    timeout: timeoutMs,
    env: mutantEnv(),
  });
  // A timed-out run is the deadline's kill, not the suite's verdict: the
  // runner exits non-zero after its SIGTERM, so ETIMEDOUT wins first.
  if (r.error?.code === 'ETIMEDOUT') return TIMEOUT;
  if (r.error) throw new MutationUnavailableError(`cannot run node --test: ${r.error.message}`);
  if (r.status === null) return TIMEOUT;
  return r.status === 0 ? SURVIVED : KILLED;
}

// ---------------------------------------------------------------------------
// Verdict

/**
 * Build the gate result from per-mutant outcomes: score
 * killed / (killed + survived), one violation per surviving mutant.
 * `integrityViolations` (project-relative paths re-restored by the
 * end-of-run tree check) rides along for the summary.
 */
export function verdict(outcomes, uncovered, opts, integrityViolations = []) {
  const killed = outcomes.filter((o) => o.outcome === KILLED).length;
  const survived = outcomes.length - killed;
  const score = outcomes.length === 0 ? 1 : killed / outcomes.length;
  const result = { killed, survived, uncovered, score, outcomes, integrityViolations, violations: [] };
  if (score >= opts.minScore && survived <= opts.maxSurvivors) return result;
  result.violations = outcomes
    .filter((o) => o.outcome !== KILLED)
    .map((o) => survivorViolation(o.site));
  return result;
}

// One violation per survived mutant so diff mode and baselines work.
function survivorViolation(site) {
  const where = site.method ? ` in ${site.method}` : '';
  return {
    file: site.rel,
    line: site.line,
    message: `survived ${site.category} mutant \`${site.original}\` -> \`${site.mutant}\`${where}`,
  };
}

function survivorsByCategory(outcomes) {
  const counts = {};
  for (const o of outcomes) {
    if (o.outcome === KILLED) continue;
    counts[o.site.category] = (counts[o.site.category] ?? 0) + 1;
  }
  return counts;
}

/**
 * The mutation gate over a file set: covered sites only, capped at
 * `max_mutants` (file order, then offset — deterministic), engine run
 * (with the digest cache session when `opts.cache` is on), verdict.
 * Skips (exit 0, empty violations) when the test command cannot be
 * spawned.
 */
export function mutationViolations(files, projectRoot, opts, deps = {}) {
  const selection = selectSites(files, projectRoot, opts, loadCoverage(resolveCoverage(opts, projectRoot), projectRoot));
  if (selection.sites.length === 0) {
    return noSites(files.length, selection.uncovered);
  }
  let engine;
  try {
    engine = runEngine(
      projectRoot,
      selection.sites,
      opts.timeoutSeconds * 1000,
      deps.runner ?? ((root, ms) => runMutantTests(root, ms, spawnSync, opts.testArgs)),
      openCache(projectRoot, opts, selection),
    );
  } catch (err) {
    if (err instanceof MutationUnavailableError) return unavailable(files.length, err.message);
    throw err;
  }
  // The tree was healed, but the run is not trustworthy — upstream writes
  // the same stderr warning alongside the summary's INTEGRITY clause.
  warnIntegrity(engine.integrityViolations.length);
  const integrity = engine.integrityViolations.map((f) => toRelPath(f, projectRoot));
  return { ...verdict(engine.outcomes, selection.uncovered, opts, integrity), checked: files.length };
}

// Opens the digest cache when `cache` is enabled: loads the file at the
// project root (a fresh empty cache on any mismatch) and binds it to the
// scan's site identities.
function openCache(projectRoot, opts, selection) {
  if (!opts.cache) return null;
  return {
    cache: MutationCache.load(path.join(projectRoot, MUTATION_CACHE_FILE_NAME), cacheMetaCurrent(opts.operators, opts.testArgs)),
    cacheFile: path.join(projectRoot, MUTATION_CACHE_FILE_NAME),
    siteMethods: selection.siteMethods,
    liveKeys: selection.liveKeys,
  };
}

function warnIntegrity(count) {
  if (count === 0) return;
  process.stderr.write(
    `crap4js mutation: working tree did not restore cleanly (${count} file(s) re-restored). Treat this run as suspect and re-run.\n`,
  );
}

// Covered sites across the file set, capped at max_mutants (file order,
// then offset — the cap is deterministic); uncovered sites only count.
// Also collects the cache identities: every scanned method's live key and,
// per covered site, its containing method's key + digest + start.
function selectSites(files, projectRoot, opts, coverage) {
  const scan = {
    projectRoot,
    enabled: new Set(opts.operators),
    maxMutants: opts.maxMutants,
    coverage,
    covered: [],
    siteMethods: new Map(),
    liveKeys: new Set(),
  };
  let uncovered = 0;
  for (const file of files) {
    if (scan.covered.length >= opts.maxMutants) break;
    uncovered += scanFileSites(file, scan);
  }
  return { sites: scan.covered, uncovered, siteMethods: scan.siteMethods, liveKeys: scan.liveKeys };
}

function scanFileSites(file, scan) {
  const source = readFileSync(file, 'utf8');
  const rel = toRelPath(file, scan.projectRoot);
  const methods = extractMethodsWithNodes(source, { ext: path.extname(file) });
  const hits = lineHits(scan.coverage.get(rel));
  for (const m of methods) scan.liveKeys.add(methodsKey(rel, m.name));
  let uncovered = 0;
  for (const s of detectSites(source, path.extname(file), scan.enabled)) {
    const method = methodContaining(methods, s.offset);
    s.file = file;
    s.rel = rel;
    s.method = method?.name ?? null;
    if (scan.covered.length >= scan.maxMutants) break;
    if (isCovered(s, hits, methods)) {
      scan.covered.push(s);
      bindRef(scan.siteMethods, s, method, source);
    } else {
      uncovered++;
    }
  }
  return uncovered;
}

// The method whose node span contains `offset`, or null.
function methodContaining(methods, offset) {
  return methods.find((m) => offset >= m.node.start && offset <= m.node.end) ?? null;
}

// The cache identity of the method containing `site`: the stable key plus
// the FNV digest of the method's exact source span.
function bindRef(siteMethods, site, method, source) {
  if (!method) return;
  siteMethods.set(site, {
    key: methodsKey(site.rel, method.name),
    digest: fnv1a64Hex(source.slice(method.node.start, method.node.end)),
    start: method.node.start,
  });
}

// The coverage file, resolved against the scanned project (not the gate's
// own cwd).
function resolveCoverage(opts, projectRoot) {
  return path.resolve(projectRoot, opts.coverage);
}

function noSites(checked, uncovered) {
  return {
    checked,
    killed: 0,
    survived: 0,
    uncovered,
    score: 1,
    violations: [],
    summary: uncovered === 0 ? 'no mutation sites' : `no covered mutation sites (${uncovered} uncovered)`,
  };
}

function unavailable(checked, message) {
  return { checked, killed: 0, survived: 0, uncovered: 0, score: 1, violations: [], summary: `test runner unavailable: ${message}` };
}

/**
 * One-line summary: pass reports the score (with the cache hit count),
 * fail appends the survivor counts by operator category; both carry an
 * INTEGRITY clause when the end-of-run tree check had to re-restore files.
 */
export function mutationSummary(r) {
  if (r.summary) return r.summary;
  const cached = (r.outcomes ?? []).filter((o) => o.fromCache).length;
  const base = `mutation score ${(r.score * 100).toFixed(1)}% (${r.killed} killed, ${r.survived} survived, ${r.uncovered} uncovered, ${cached} cached)`;
  const integrity = (r.integrityViolations ?? []).length === 0
    ? ''
    : `; INTEGRITY: re-restored after run: ${r.integrityViolations.join(', ')}`;
  if (r.violations === 0) return base + integrity;
  const byCategory = Object.entries(survivorsByCategory(r.outcomes))
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `${base}; survivors by category: ${byCategory}${integrity}`;
}

// ---------------------------------------------------------------------------
// Command plumbing

const VALUE_FLAGS = {
  '--min-score': 'minScore',
  '--max-survivors': 'maxSurvivors',
  '--timeout-seconds': 'timeoutSeconds',
  '--max-mutants': 'maxMutants',
  '--coverage': 'coverage',
  '--exclude': 'exclude',
  '--operators': 'operators',
  '--test-args': 'testArgs',
};
const NUMBER_FLAGS = new Set(['--min-score', '--max-survivors', '--timeout-seconds', '--max-mutants']);
// Boolean switch pair (no value): `--no-cache` opts out of the digest
// cache, `--cache` turns it back on.
const BOOL_FLAGS = { '--cache': true, '--no-cache': false };

/**
 * Parse `mutation` arguments into `{ minScore, maxSurvivors,
 * timeoutSeconds, maxMutants, coverage, operators, exclude, cache,
 * testArgs, paths }`. Value flags may be written `--flag VALUE` or
 * `--flag=VALUE`; `--exclude`, `--operators` and `--test-args` are
 * repeatable (test-args values append to the default `--test`).
 *
 * @param {string[]} argv
 */
export function parseMutationArgs(argv) {
  const opts = {
    minScore: DEFAULT_MIN_SCORE,
    maxSurvivors: DEFAULT_MAX_SURVIVORS,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    maxMutants: DEFAULT_MAX_MUTANTS,
    coverage: DEFAULT_COVERAGE,
    operators: [],
    exclude: [],
    cache: DEFAULT_CACHE,
    testArgs: [...DEFAULT_TEST_ARGS],
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const bool = BOOL_FLAGS[argv[i]];
    if (bool !== undefined) {
      opts.cache = bool;
      continue;
    }
    i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  // `operators` selects a subset; with no flag all categories are enabled.
  if (opts.operators.length === 0) opts.operators = [...OPERATOR_CATEGORIES];
  validateOperators(opts.operators);
  validateTestArgs(opts.testArgs);
  return opts;
}

// Upstream validates `test_args` strictly: a non-empty list of non-empty
// strings — an empty entry would silently produce a truncated invocation.
function validateTestArgs(testArgs) {
  if (testArgs.length === 0) throw new Error('--test-args must not be empty');
  for (const arg of testArgs) {
    if (arg === '') throw new Error('--test-args arguments must be non-empty strings');
  }
}

function validateOperators(operators) {
  for (const op of operators) {
    if (!OPERATOR_CATEGORIES.includes(op)) {
      throw new Error(`unknown operator category: ${op} (valid: ${OPERATOR_CATEGORIES.join(', ')})`);
    }
  }
}

// The gate's file set: explicit paths or the src/ walk — test files and
// test directories always excluded (the port's standard default, upstream
// `test/**` glob), then --exclude globs matched project-relatively.
function scanSet(opts, projectRoot) {
  const globs = opts.exclude.map(globToRegExp);
  return gateFiles(opts.paths, projectRoot)
    .filter((f) => !isTestPath(f) && !globs.some((g) => g.test(toRelPath(f, projectRoot))))
    .sort();
}

/**
 * The `mutation` command body. Skips (exit 0) without coverage data or a
 * test directory — mutation testing needs both. Returns exit code 2 iff
 * any covered mutant survived past the thresholds.
 */
export function runMutation(argv, ctx) {
  const opts = parseMutationArgs(argv);
  const skip = skipReason(ctx.cwd, opts);
  if (skip) {
    ctx.out.write(`mutation: skipped — ${skip}\n`);
    return 0;
  }
  return runCheck(
    ctx,
    scanSet(opts, ctx.cwd),
    (files, root) => mutationViolations(files, root, opts),
    mutationSummary,
  );
}

// Upstream skips without coverage data or without a test directory.
function skipReason(projectRoot, opts) {
  if (!existsSync(path.resolve(projectRoot, opts.coverage))) {
    return 'no coverage data (run the tests with coverage first)';
  }
  if (!existsSync(path.join(projectRoot, 'test'))) return 'no test directory';
  return null;
}
