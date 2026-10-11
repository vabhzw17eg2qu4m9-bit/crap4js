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
// not kill it deterministically. The file is restored after every mutant.
//
// Expensive — the test suite runs once per mutant — so like every gate
// here it only runs when invoked as the `mutation` subcommand (upstream:
// disabled by default).
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

const DEFAULT_MIN_SCORE = 0.8;
const DEFAULT_MAX_SURVIVORS = 0;
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_MUTANTS = 500;
const DEFAULT_COVERAGE = 'coverage/coverage-final.json';

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

// The method whose node span contains `offset`, or null (for names).
function methodAt(methods, offset) {
  return methods.find((m) => offset >= m.node.start && offset <= m.node.end)?.name ?? null;
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
 * after timeouts and errors). Returns one `{site, outcome}` per site.
 */
export function runEngine(projectRoot, sites, timeoutMs, runner) {
  const outcomes = [];
  for (const site of sites) {
    const original = readFileSync(site.file, 'utf8');
    writeFileSync(site.file, original.slice(0, site.offset) + site.mutant + original.slice(site.offset + site.length));
    try {
      outcomes.push({ site, outcome: runner(projectRoot, timeoutMs) });
    } finally {
      writeFileSync(site.file, original);
    }
  }
  return outcomes;
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
 * MutationUnavailableError when the spawn itself fails.
 */
export function runMutantTests(projectRoot, timeoutMs, spawn = spawnSync) {
  const r = spawn(process.execPath, ['--test'], {
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
 */
export function verdict(outcomes, uncovered, opts) {
  const killed = outcomes.filter((o) => o.outcome === KILLED).length;
  const survived = outcomes.length - killed;
  const score = outcomes.length === 0 ? 1 : killed / outcomes.length;
  const result = { killed, survived, uncovered, score, outcomes, violations: [] };
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
 * `max_mutants` (file order, then offset — deterministic), engine run,
 * verdict. Skips (exit 0, empty violations) when the test command cannot
 * be spawned.
 */
export function mutationViolations(files, projectRoot, opts, deps = {}) {
  const selection = selectSites(files, projectRoot, opts, loadCoverage(resolveCoverage(opts, projectRoot), projectRoot));
  if (selection.sites.length === 0) {
    return noSites(files.length, selection.uncovered);
  }
  let outcomes;
  try {
    outcomes = runEngine(projectRoot, selection.sites, opts.timeoutSeconds * 1000, deps.runner ?? runMutantTests);
  } catch (err) {
    if (err instanceof MutationUnavailableError) return unavailable(files.length, err.message);
    throw err;
  }
  return { ...verdict(outcomes, selection.uncovered, opts), checked: files.length };
}

// Covered sites across the file set, capped at max_mutants (file order,
// then offset — the cap is deterministic); uncovered sites only count.
function selectSites(files, projectRoot, opts, coverage) {
  const enabled = new Set(opts.operators);
  const covered = [];
  let uncovered = 0;
  for (const file of files) {
    if (covered.length >= opts.maxMutants) break;
    const source = readFileSync(file, 'utf8');
    const ext = path.extname(file);
    const methods = extractMethodsWithNodes(source, { ext });
    const hits = lineHits(coverage.get(toRelPath(file, projectRoot)));
    for (const s of detectSites(source, ext, enabled)) {
      s.file = file;
      s.rel = toRelPath(file, projectRoot);
      s.method = methodAt(methods, s.offset);
      if (covered.length >= opts.maxMutants) break;
      if (isCovered(s, hits, methods)) covered.push(s);
      else uncovered++;
    }
  }
  return { sites: covered, uncovered };
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
 * One-line summary: pass reports the score, fail appends the survivor
 * counts by operator category.
 */
export function mutationSummary(r) {
  if (r.summary) return r.summary;
  const base = `mutation score ${(r.score * 100).toFixed(1)}% (${r.killed} killed, ${r.survived} survived, ${r.uncovered} uncovered)`;
  if (r.violations === 0) return base;
  const byCategory = Object.entries(survivorsByCategory(r.outcomes))
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `${base}; survivors by category: ${byCategory}`;
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
};
const NUMBER_FLAGS = new Set(['--min-score', '--max-survivors', '--timeout-seconds', '--max-mutants']);

/**
 * Parse `mutation` arguments into `{ minScore, maxSurvivors,
 * timeoutSeconds, maxMutants, coverage, operators, exclude, paths }`.
 * Value flags may be written `--flag VALUE` or `--flag=VALUE`;
 * `--exclude` and `--operators` are repeatable.
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
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  // `operators` selects a subset; with no flag all categories are enabled.
  if (opts.operators.length === 0) opts.operators = [...OPERATOR_CATEGORIES];
  validateOperators(opts.operators);
  return opts;
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
