import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  KILLED,
  OPERATOR_CATEGORIES,
  SURVIVED,
  TIMEOUT,
  detectSites,
  mutationSummary,
  mutationViolations,
  parseMutationArgs,
  runEngine,
  runMutation,
  runMutantTests,
  verdict,
} from '../src/mutation.js';
import { main } from '../src/cli.js';
import { extractMethodsWithNodes } from '../src/complexity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

// sign() has exactly six covered mutation sites on line 2; the tests kill
// five of them and miss exactly one (the `> 0` zero — sign never treats
// the n > 1 mutant differently), so the default gate fails with a single
// violation. Every fixture below leans on that measured outcome.
const SIGN_SRC = `export function sign(n) {
  return n > 0 ? 1 : -1;
}
`;
// Line 2 of SIGN_SRC, kept in sync by hand for coverage fixtures.
const SIGN_LINE = 2;

function project(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-mutation-'));
  for (const [rel, source] of Object.entries({ 'package.json': '{"type":"module"}', ...files })) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// Istanbul coverage JSON marking `lines` of `src/<name>` as executed once.
function coverageEntry(name, lines) {
  const statementMap = {};
  const s = {};
  lines.forEach((line, i) => {
    statementMap[i] = { start: { line, column: 0 }, end: { line, column: 40 } };
    s[i] = 1;
  });
  return { statementMap, s };
}

function writeCoverage(root, entries) {
  const coverage = {};
  for (const [name, entry] of Object.entries(entries)) {
    coverage[path.join(root, 'src', name)] = entry;
  }
  mkdirSync(path.join(root, 'coverage'), { recursive: true });
  writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), JSON.stringify(coverage));
}

function signProject(extra = {}) {
  const root = project({
    'src/lib.js': SIGN_SRC,
    'test/sign.test.js': `import assert from 'node:assert';
import test from 'node:test';
import { sign } from '../src/lib.js';

test('sign', () => {
  assert.equal(sign(5), 1);
  assert.equal(sign(-5), -1);
  assert.equal(sign(0), -1);
});
`,
    ...extra,
  });
  writeCoverage(root, { 'lib.js': coverageEntry('lib.js', [SIGN_LINE]) });
  return root;
}

function fakeCtx(cwd) {
  const out = [];
  return { cwd, out: { write: (s) => out.push(s) }, lines: out };
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

// Real per-mutant runner that also counts invocations (for cap and
// uncovered-exclusion assertions).
function countingRunner() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: (root, timeoutMs) => {
      calls++;
      return runMutantTests(root, timeoutMs);
    },
  };
}

test('parseMutationArgs: upstream defaults, repeatable operators and exclude', () => {
  assert.deepStrictEqual(parseMutationArgs([]), {
    minScore: 0.8,
    maxSurvivors: 0,
    timeoutSeconds: 60,
    maxMutants: 500,
    coverage: 'coverage/coverage-final.json',
    operators: [...OPERATOR_CATEGORIES],
    exclude: [],
    cache: true,
    testArgs: ['--test'],
    diffBase: null,
    scopeTests: false,
    paths: [],
  });
  const opts = parseMutationArgs([
    '--min-score', '0.5',
    '--max-survivors=2',
    '--timeout-seconds', '10',
    '--max-mutants', '7',
    '--operators', 'boundary',
    '--operators=equality',
    '--exclude', '**.gen.js',
    'src/a.js',
  ]);
  assert.equal(opts.minScore, 0.5);
  assert.equal(opts.maxSurvivors, 2);
  assert.equal(opts.timeoutSeconds, 10);
  assert.equal(opts.maxMutants, 7);
  assert.deepStrictEqual(opts.operators, ['boundary', 'equality']);
  assert.deepStrictEqual(opts.exclude, ['**.gen.js']);
  assert.deepStrictEqual(opts.paths, ['src/a.js']);
  // `--coverage` overrides its scalar default (both spellings) instead of
  // accumulating — pre-fix the default string was spread char-by-char and
  // the gate died on `path.resolve` with the resulting array.
  assert.equal(parseMutationArgs(['--coverage', 'cov/main.json']).coverage, 'cov/main.json');
  assert.equal(parseMutationArgs(['--coverage=cov/main.json']).coverage, 'cov/main.json');
});

test('parseMutationArgs: unknown category and invalid number are usage errors', () => {
  assert.throws(() => parseMutationArgs(['--operators', 'bitwise']), /unknown operator category: bitwise/);
  assert.throws(() => parseMutationArgs(['--min-score', 'high']), /Invalid --min-score/);
});

test('detectSites: spans replace exactly the matched lexeme, one row one mutant', () => {
  const source = `const a = x > 0 && y !== 1;
const b = flag ? true : 0;
const c = sum / total;
const d = !ok;
`;
  const sites = detectSites(source, '.js');
  // Every site's span covers exactly its original lexeme...
  for (const s of sites) {
    assert.equal(source.slice(s.offset, s.offset + s.length), s.original, `${s.category} span`);
  }
  const byLex = (lex) => sites.filter((s) => s.original === lex).map((s) => s.mutant);
  assert.deepStrictEqual(byLex('>'), ['>=', '<']);
  assert.deepStrictEqual(byLex('&&'), ['||']);
  assert.deepStrictEqual(byLex('!=='), ['===']);
  assert.deepStrictEqual(byLex('true'), ['false']);
  assert.deepStrictEqual(byLex('0'), ['1', '1']); // two 0 lexemes, one row each
  assert.deepStrictEqual(byLex('1'), ['0']);
  assert.deepStrictEqual(byLex('/'), ['*', '%']); // two rows, two mutants
  assert.deepStrictEqual(byLex('!'), ['']); // unary deletion
  // ...and applying one really rewrites only that span.
  const gt = sites.find((s) => s.original === '>' && s.mutant === '>=');
  const mutated = source.slice(0, gt.offset) + '>=' + source.slice(gt.offset + gt.length);
  assert.equal(mutated, `const a = x >= 0 && y !== 1;
const b = flag ? true : 0;
const c = sum / total;
const d = !ok;
`);
});

test('detectSites: -1 yields both the whole-span and the operand constant sites', () => {
  const sites = detectSites('const step = -1;\n', '.js', ['constant']);
  assert.deepStrictEqual(
    sites.map((s) => [s.original, s.mutant, s.length]),
    [['-1', '0', 2], ['1', '0', 1]],
  );
});

test('detectSites: non-bare lexemes never mutate; postfix TS ! never mutates', () => {
  assert.deepEqual(detectSites('const a = [0x0, 1.5];\n', '.js'), []);
  assert.deepEqual(detectSites('const b = c!;\n', '.ts', ['unary']), []);
});

test('runMutantTests: exit mapping and timeout, real test suite, file restored', () => {
  assert.equal(runMutantTests('.', 30_000, () => ({ status: 0 })), SURVIVED);
  assert.equal(runMutantTests('.', 30_000, () => ({ status: 1 })), KILLED);
  assert.equal(runMutantTests('.', 30_000, () => ({ status: null })), TIMEOUT);
  assert.equal(runMutantTests('.', 30_000, () => ({ status: null, error: { code: 'ETIMEDOUT', message: 'killed' } })), TIMEOUT);
  assert.throws(() => runMutantTests('.', 30_000, () => ({ error: { code: 'ENOENT', message: 'boom' } })),
    /cannot run node --test: boom/);

  const root = signProject();
  try {
    // Real suite passes: survived. A hanging suite is killed by the
    // timeout and counts as TIMEOUT (survived).
    assert.equal(runMutantTests(root, 60_000), SURVIVED);
    const hanging = project({
      'src/loopy.js': 'export const forever = 1;\n',
      'test/loopy.test.js': `import test from 'node:test';
test('hangs', () => { setInterval(() => {}, 10_000); });
`,
    });
    writeCoverage(hanging, { 'loopy.js': coverageEntry('loopy.js', [1]) });
    const sites = detectSites(readFileSync(path.join(hanging, 'src/loopy.js'), 'utf8'), '.js');
    sites.forEach((s) => { s.file = path.join(hanging, 'src/loopy.js'); });
    const { outcomes } = runEngine(hanging, sites, 1_000, (r, ms) => runMutantTests(r, ms));
    assert.equal(outcomes[0].outcome, TIMEOUT);
    assert.equal(readFileSync(path.join(hanging, 'src/loopy.js'), 'utf8'), 'export const forever = 1;\n');
    cleanup(hanging);
  } finally {
    cleanup(root);
  }
});

test('engine: real mutants — five killed, one survived, file restored after every mutant', () => {
  const root = signProject();
  try {
    const file = path.join(root, 'src/lib.js');
    const sites = detectSites(SIGN_SRC, '.js');
    assert.equal(sites.length, 6);
    sites.forEach((s) => { s.file = file; });
    const { outcomes, integrityViolations } = runEngine(root, sites, 60_000, (r, ms) => runMutantTests(r, ms));
    assert.equal(outcomes.filter((o) => o.outcome === KILLED).length, 5);
    assert.equal(outcomes.filter((o) => o.outcome === SURVIVED).length, 1);
    assert.equal(outcomes.find((o) => o.outcome === SURVIVED).site.original, '0');
    assert.deepEqual(integrityViolations, []);
    assert.equal(readFileSync(file, 'utf8'), SIGN_SRC);
  } finally {
    cleanup(root);
  }
});

test('verdict: score thresholds and survivor cap decide pass/fail', () => {
  const site = { rel: 'src/lib.js', line: 2, category: 'constant', original: '0', mutant: '1' };
  // 4 killed + 1 survived: score 0.8, one survivor over the default cap.
  const outcomes = [
    { site, outcome: SURVIVED },
    ...['>', '<', '1', '-1'].map((original) => ({ site: { ...site, original }, outcome: KILLED })),
  ];
  const fail = verdict(outcomes, 3, { minScore: 0.8, maxSurvivors: 0 });
  assert.equal(fail.violations.length, 1);
  assert.equal(fail.violations[0].file, 'src/lib.js');
  assert.equal(fail.violations[0].line, 2);
  assert.equal(fail.score, 0.8);
  const pass = verdict(outcomes, 3, { minScore: 0.8, maxSurvivors: 1 });
  assert.deepEqual(pass.violations, []);
  const lowScore = verdict(outcomes, 3, { minScore: 0.9, maxSurvivors: 5 });
  assert.equal(lowScore.violations.length, 1); // 0.8 < 0.9 fails even with cap headroom
});

test('mutationViolations: end-to-end — covered sites only, survivors flagged with file and line', () => {
  const root = signProject({
    // Never covered: absent from the coverage JSON, so its sites are
    // excluded from the score and never executed.
    'src/never.js': 'export const dead = 0 === 1;\n',
  });
  try {
    const runner = countingRunner();
    const result = mutationViolations(
      [path.join(root, 'src/lib.js'), path.join(root, 'src/never.js')],
      root,
      parseMutationArgs([]),
      { runner: runner.run },
    );
    // 6 sign sites executed; the 3 uncovered sites of never.js only count.
    assert.equal(runner.calls, 6);
    assert.equal(result.uncovered, 3);
    assert.equal(result.killed, 5);
    assert.equal(result.survived, 1);
    assert.equal(result.violations.length, 1);
    assert.deepEqual(result.violations[0], {
      file: 'src/lib.js',
      line: SIGN_LINE,
      message: 'survived constant mutant `0` -> `1` in sign',
    });
  } finally {
    cleanup(root);
  }
});

test('mutationViolations: max_mutants caps the executed sites deterministically', () => {
  const root = signProject();
  try {
    const runner = countingRunner();
    const result = mutationViolations(
      [path.join(root, 'src/lib.js')],
      root,
      parseMutationArgs(['--max-mutants', '2']),
      { runner: runner.run },
    );
    assert.equal(runner.calls, 2);
    assert.equal(result.killed, 2); // both head sites (> >= and > <) die
  } finally {
    cleanup(root);
  }
});

test('mutationViolations: module-load failure kills the mutant like a compile error', () => {
  // RETRIES = 1 breaks a top-level guard: the module throws on import, so
  // the suite refuses to run — the JS analog of upstream's compile-error
  // kill. Every site of this file dies that way.
  const root = project({
    'src/guarded.js': `export const RETRIES = 0;
if (RETRIES !== 0) throw new Error('bad RETRIES');
`,
    'test/guarded.test.js': `import assert from 'node:assert';
import test from 'node:test';
import { RETRIES } from '../src/guarded.js';

test('retries', () => assert.equal(RETRIES, 0));
`,
  });
  writeCoverage(root, { 'guarded.js': coverageEntry('guarded.js', [1, 2]) });
  try {
    const file = path.join(root, 'src/guarded.js');
    const sites = detectSites(readFileSync(file, 'utf8'), '.js');
    sites.forEach((s) => { s.file = file; });
    assert.equal(sites.length, 3); // `0`, `!==`, `0`
    const { outcomes } = runEngine(root, sites, 60_000, (r, ms) => runMutantTests(r, ms));
    assert.equal(outcomes.length, 3);
    assert.ok(outcomes.every((o) => o.outcome === KILLED), 'every mutant killed');
  } finally {
    cleanup(root);
  }
});

test('runMutation: skips without coverage data and without a test directory', () => {
  const bare = project({ 'src/lib.js': SIGN_SRC });
  try {
    const ctx = fakeCtx(bare);
    assert.equal(runMutation(['src/lib.js'], ctx), 0);
    assert.match(ctx.lines[0], /^mutation: skipped — no coverage data/);

    writeCoverage(bare, { 'lib.js': coverageEntry('lib.js', [SIGN_LINE]) });
    rmSync(path.join(bare, 'test'), { recursive: true, force: true });
    const ctx2 = fakeCtx(bare);
    assert.equal(runMutation(['src/lib.js'], ctx2), 0);
    assert.equal(ctx2.lines[0], 'mutation: skipped — no test directory\n');
  } finally {
    cleanup(bare);
  }
});

test('runMutation: violation lines, summary, and exit code through the CLI', () => {
  const root = signProject();
  try {
    const r = runCli(root, ['mutation']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /src\/lib\.js:2: survived constant mutant `0` -> `1` in sign/);
    assert.match(r.stdout, /mutation score 83\.3% \(5 killed, 1 survived, 0 uncovered, 0 cached\)/);
    assert.match(r.stdout, /; survivors by category: constant=1/);

    // Loosening the survivor cap passes the same run (--no-cache: the
    // first run just cached the kills; this one re-executes cold).
    const ok = runCli(root, ['mutation', '--max-survivors', '1', '--no-cache']);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /mutation score 83\.3% \(5 killed, 1 survived, 0 uncovered, 0 cached\)/);
  } finally {
    cleanup(root);
  }
});

test('mutation gate is opt-in: the default analyze run never mutates', () => {
  const root = signProject();
  try {
    const r = runCli(root, []);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /mutation score|survived .* mutant/);
    assert.match(r.stdout, /CRAP|Cov%/);
    // And an unknown subcommand spelling falls through to analyze, not mutation.
    const ctx = fakeCtx(root);
    assert.doesNotThrow(() => main(['mutationx'], { out: ctx.out, err: ctx.out }));
    assert.doesNotMatch(ctx.lines.join(''), /mutation score/);
  } finally {
    cleanup(root);
  }
});

test('mutationSummary formats the pass, fail, skip, and integrity lines', () => {
  assert.equal(
    mutationSummary({ killed: 5, survived: 1, uncovered: 0, score: 5 / 6, violations: 0 }),
    'mutation score 83.3% (5 killed, 1 survived, 0 uncovered, 0 cached)',
  );
  assert.equal(
    mutationSummary({
      killed: 5, survived: 1, uncovered: 2, score: 5 / 6, violations: 1,
      outcomes: [{ outcome: SURVIVED, site: { category: 'constant' } }, { outcome: KILLED, fromCache: true, site: { category: 'boundary' } }],
    }),
    'mutation score 83.3% (5 killed, 1 survived, 2 uncovered, 1 cached); survivors by category: constant=1',
  );
  assert.equal(
    mutationSummary({
      killed: 5, survived: 0, uncovered: 0, score: 1, violations: 0,
      outcomes: [{ outcome: KILLED, fromCache: true, site: { category: 'boundary' } }],
      integrityViolations: ['src/lib.js'],
    }),
    'mutation score 100.0% (5 killed, 0 survived, 0 uncovered, 1 cached); INTEGRITY: re-restored after run: src/lib.js',
  );
  assert.equal(mutationSummary({ summary: 'no covered mutation sites (3 uncovered)', violations: 0 }),
    'no covered mutation sites (3 uncovered)');
});

// ---------------------------------------------------------------------------
// Diff-scoped execution + scope_tests (port of crap4dart 8228585)

test('parseMutationArgs: --diff-base and --scope-tests flags', () => {
  assert.equal(parseMutationArgs(['--diff-base', 'origin/main']).diffBase, 'origin/main');
  assert.equal(parseMutationArgs(['--diff-base=HEAD~1']).diffBase, 'HEAD~1');
  assert.equal(parseMutationArgs(['--scope-tests']).scopeTests, true);
  assert.equal(parseMutationArgs(['--scope-tests', '--no-scope-tests']).scopeTests, false);
  assert.equal(parseMutationArgs(['--no-scope-tests']).scopeTests, false);
  assert.throws(() => parseMutationArgs(['--diff-base=']), /--diff-base requires a non-empty git ref/);
});

// keeper (lines 1-3) + drifter (lines 5-7): the diff-scoping fixture.
const PAIR_SRC = `export function keeper(n) {
  return n > 0 ? 1 : -1;
}

export function drifter(n) {
  return n > 0 ? 2 : -2;
}
`;

// Per-mutant runner that records every invocation's resolved arguments
// and returns outcomes from `script` (call number 1-based).
function scriptedRunner(script = () => KILLED) {
  const argSets = [];
  return {
    get calls() {
      return argSets.length;
    },
    get argSets() {
      return argSets;
    },
    run: (_root, _timeoutMs, testArgs) => {
      argSets.push(testArgs);
      return script(argSets.length);
    },
  };
}

// The name of the method whose span contains `offset`, or null.
function methodNamed(methods, offset) {
  return methods.find((m) => offset >= m.node.start && offset <= m.node.end)?.name ?? null;
}

test('mutationViolations: diff scoping executes only the mutants of changed methods', () => {
  const root = project({ 'src/pair.js': PAIR_SRC });
  writeCoverage(root, { 'pair.js': coverageEntry('pair.js', [2, 6]) });
  try {
    const file = path.join(root, 'src/pair.js');
    const all = detectSites(PAIR_SRC, '.js');
    const methods = extractMethodsWithNodes(PAIR_SRC, { ext: '.js' });
    const keeperSites = all.filter((s) => methodNamed(methods, s.offset) === 'keeper').length;
    // keeper (`1`/`-1` mutate) has 6 sites; drifter (`2`/`-2` are not
    // bare 0/1 lexemes — only its `>` rows and `0` mutate) has 3.
    assert.equal(all.length, 9);
    assert.equal(keeperSites, 6);

    // Without a diff both methods' sites execute.
    const full = scriptedRunner();
    const fullRun = mutationViolations([file], root, parseMutationArgs(['--no-cache']), { runner: full.run });
    assert.equal(full.calls, 9);
    assert.equal(fullRun.killed, 9);

    // The diff marks ONLY line 3 — keeper's closing brace: inside
    // keeper's method range, outside drifter's, and not a site line
    // itself — so the intersection is method-level, not line-level.
    const scoped = scriptedRunner();
    const opts = { ...parseMutationArgs(['--no-cache']), diffLines: new Map([['src/pair.js', new Set([3])]]) };
    const scopedRun = mutationViolations([file], root, opts, { runner: scoped.run });
    assert.equal(scoped.calls, keeperSites);
    assert.ok(scopedRun.outcomes.every((o) => o.site.method === 'keeper'), 'only keeper mutants ran');
    assert.equal(scopedRun.killed, keeperSites);
    assert.equal(scopedRun.uncovered, 0, 'diff-filtered sites are neither executed nor counted');
    assert.equal(scopedRun.scopedCount, 0, 'diff scoping is not test scoping');
  } finally {
    cleanup(root);
  }
});

test('mutationViolations: scope_tests derives the test files and caches scoped kills as regular kills', () => {
  // src/lib.js derives test/src/lib.test.js and test/lib.test.js; the
  // second exists (signProject's test/sign.test.js matches nothing).
  const root = signProject({ 'test/lib.test.js': 'export const unused = true;\n' });
  try {
    const scoped = scriptedRunner();
    const run1 = mutationViolations([path.join(root, 'src/lib.js')], root, parseMutationArgs(['--scope-tests']), { runner: scoped.run });
    assert.equal(scoped.calls, 6);
    for (const args of scoped.argSets) assert.deepEqual(args, ['--test', 'test/lib.test.js']);
    assert.equal(run1.scopedCount, 6);
    assert.equal(run1.confirmedCount, 0);
    assert.equal(run1.killed, 6);

    // A scoped kill is monotone: without scoping the same kills replay
    // from the cache — the meta fingerprint deliberately ignores
    // scope_tests, so nothing re-executes.
    const replay = scriptedRunner(() => {
      throw new Error('scoped kill must be replayed, not re-executed');
    });
    const run2 = mutationViolations([path.join(root, 'src/lib.js')], root, parseMutationArgs([]), { runner: replay.run });
    assert.equal(replay.calls, 0);
    assert.equal(run2.killed, 6);
    assert.ok(run2.outcomes.every((o) => o.fromCache));
  } finally {
    cleanup(root);
  }
});

// One-site fixture: src/ok.js holds exactly one mutation site (the unary
// row deletes the `!` — no constants, no comparison rows), inside method
// `ok` so the site has a cache identity. BOTH derived test-file
// candidates exist.
function oneSiteProject() {
  const root = project({
    'src/ok.js': 'export function ok(n) {\n  return !n;\n}\n',
    'test/src/ok.test.js': 'export const marker = 1;\n',
    'test/ok.test.js': 'export const marker = 1;\n',
  });
  writeCoverage(root, { 'ok.js': coverageEntry('ok.js', [2]) });
  return root;
}

test('scope_tests: a scoped survivor is re-confirmed once; only the confirmed outcome is reported and cached', () => {
  const root = oneSiteProject();
  try {
    // Scoped run survives, the full-invocation confirmation kills it.
    const runner = scriptedRunner((call) => (call === 1 ? SURVIVED : KILLED));
    const r = mutationViolations([path.join(root, 'src/ok.js')], root, parseMutationArgs(['--scope-tests']), { runner: runner.run });
    assert.deepEqual(runner.argSets, [
      ['--test', 'test/src/ok.test.js', 'test/ok.test.js'],
      ['--test'],
    ]);
    assert.equal(r.scopedCount, 1);
    assert.equal(r.confirmedCount, 1);
    assert.equal(r.killed, 1);
    assert.equal(r.survived, 0);
    assert.deepEqual(r.violations, []);

    // The confirmed kill is cached as a regular kill — a follow-up run
    // replays it without executing anything.
    const replay = scriptedRunner(() => {
      throw new Error('confirmed kill must be replayed, not re-executed');
    });
    const r2 = mutationViolations([path.join(root, 'src/ok.js')], root, parseMutationArgs([]), { runner: replay.run });
    assert.equal(replay.calls, 0);
    assert.equal(r2.killed, 1);
    assert.ok(r2.outcomes[0].fromCache);
  } finally {
    cleanup(root);
  }
});

test('scope_tests: a scoped timeout is a survivor and gets re-confirmed', () => {
  const root = oneSiteProject();
  try {
    const runner = scriptedRunner((call) => (call === 1 ? TIMEOUT : KILLED));
    const r = mutationViolations([path.join(root, 'src/ok.js')], root, parseMutationArgs(['--scope-tests']), { runner: runner.run });
    assert.equal(runner.calls, 2);
    assert.deepEqual(runner.argSets[1], ['--test']);
    assert.equal(r.killed, 1);
    assert.equal(r.confirmedCount, 1);
  } finally {
    cleanup(root);
  }
});

test('scope_tests: a confirmed survivor stays a survivor and is never cached', () => {
  const root = oneSiteProject();
  try {
    const runner = scriptedRunner(() => SURVIVED);
    const r = mutationViolations([path.join(root, 'src/ok.js')], root, parseMutationArgs(['--scope-tests']), { runner: runner.run });
    assert.equal(runner.calls, 2, 'exactly one confirmation run');
    assert.equal(r.survived, 1);
    assert.equal(r.confirmedCount, 0);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].file, 'src/ok.js');

    // Survivors never replay: the cached confirmed outcome is not a kill.
    const next = scriptedRunner(() => SURVIVED);
    const r2 = mutationViolations([path.join(root, 'src/ok.js')], root, parseMutationArgs([]), { runner: next.run });
    assert.equal(next.calls, 1);
    assert.equal(r2.survived, 1);
    assert.equal(r2.outcomes[0].fromCache, false);
  } finally {
    cleanup(root);
  }
});

test('scope_tests: no derived test file falls back to the full invocation without re-confirmation', () => {
  // signProject's suite lives at test/sign.test.js — not a derived
  // candidate of src/lib.js (test/src/lib.test.js, test/lib.test.js).
  const root = signProject();
  try {
    const runner = scriptedRunner(() => SURVIVED);
    const r = mutationViolations([path.join(root, 'src/lib.js')], root, parseMutationArgs(['--scope-tests']), { runner: runner.run });
    assert.equal(runner.calls, 6);
    for (const args of runner.argSets) assert.deepEqual(args, ['--test'], 'fallback runs the full invocation');
    assert.equal(r.scopedCount, 0, 'the fallback is not scoping');
    assert.equal(r.confirmedCount, 0);
    assert.equal(r.survived, 6);
  } finally {
    cleanup(root);
  }
});

test('mutationSummary appends the test-scoped clause when scoping ran', () => {
  assert.equal(
    mutationSummary({ killed: 1, survived: 0, uncovered: 0, score: 1, violations: 0, outcomes: [{ fromCache: false }], scopedCount: 1, confirmedCount: 1 }),
    'mutation score 100.0% (1 killed, 0 survived, 0 uncovered, 0 cached); test-scoped 1 (1 re-confirmed killed)',
  );
  assert.equal(
    mutationSummary({
      killed: 0, survived: 1, uncovered: 0, score: 0, violations: 1,
      outcomes: [{ outcome: SURVIVED, site: { category: 'boolean' }, fromCache: false }],
      scopedCount: 2, confirmedCount: 0,
    }),
    'mutation score 0.0% (0 killed, 1 survived, 0 uncovered, 0 cached); survivors by category: boolean=1; test-scoped 2 (0 re-confirmed killed)',
  );
});

test('runMutation --diff-base executes only the changed methods mutants end-to-end', () => {
  const keeperV = (ret) => `export function keeper(n) {
  return n + ${ret};
}

export function drifter(n) {
  return n > 0 ? 1 : -1;
}
`;
  const root = project({
    'src/lib.js': keeperV(2),
    // Assertions match the CHANGED keeper (n + 1): a stale suite would
    // fail on every mutant of the file and mask the survivor.
    'test/lib.test.js': `import assert from 'node:assert';
import test from 'node:test';
import { keeper, drifter } from '../src/lib.js';

test('keeper', () => {
  assert.equal(keeper(1), 2);
  assert.equal(keeper(-1), 0);
});
test('drifter', () => {
  assert.equal(drifter(5), 1);
  assert.equal(drifter(-5), -1);
  assert.equal(drifter(0), -1);
});
`,
  });
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  // Change ONLY keeper (line 2) after the commit; drifter stays untouched.
  writeFileSync(path.join(root, 'src/lib.js'), keeperV(1));
  writeCoverage(root, { 'lib.js': coverageEntry('lib.js', [2, 6]) });
  try {
    // Full run: drifter's `0` -> `1` mutant survives (no test drives
    // 0 < n <= 1), so the gate fails.
    const full = runCli(root, ['mutation']);
    assert.equal(full.status, 2);
    assert.match(full.stdout, /1 survived/);

    // Diff-scoped run: only keeper (line 2 changed) is a mutant of this
    // change — drifter's sites are neither executed nor counted, its
    // survivor vanishes, and keeper's kills replay from the cache the
    // full run just wrote (same meta fingerprint).
    const scoped = runCli(root, ['mutation', '--diff-base', 'HEAD']);
    assert.equal(scoped.status, 0);
    assert.match(scoped.stdout, /mutation score 100\.0% \(2 killed, 0 survived, 0 uncovered, 2 cached\)/);
  } finally {
    cleanup(root);
  }
});
