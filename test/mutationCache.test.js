import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  KILLED,
  SURVIVED,
  mutationSummary,
  mutationViolations,
  parseMutationArgs,
  runEngine,
  runMutantTests,
} from '../src/mutation.js';
import {
  MUTATION_CACHE_FILE_NAME,
  MUTATION_CACHE_VERSION,
  MutationCache,
  cacheMetaCurrent,
  fnv1a64Hex,
  methodsKey,
} from '../src/mutationCache.js';

// Two top-level functions in one file: `add` has one arithmetic site, `zero`
// one constant site — the minimal fixture for method-relative invalidation
// (an edit inside `add` must not invalidate `zero`'s cached kills, even
// though `zero`'s absolute offsets shift).
const TWO_SRC = `export function add(a, b) {
  return a + b;
}

export function zero() {
  return 0;
}
`;
// `add` with a clarifying comment inserted inside the body.
const TWO_EDITED = `export function add(a, b) {
  // a clarifying comment
  return a + b;
}

export function zero() {
  return 0;
}
`;

const META = cacheMetaCurrent(['arithmetic', 'constant'], ['--test']);

function project(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-mcache-'));
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

// Istanbul coverage JSON marking `lines` of `src/lib.js` as executed once.
function writeCoverage(root, lines) {
  const statementMap = {};
  const s = {};
  lines.forEach((line, i) => {
    statementMap[i] = { start: { line, column: 0 }, end: { line, column: 40 } };
    s[i] = 1;
  });
  const coverage = { [path.join(root, 'src', 'lib.js')]: { statementMap, s } };
  mkdirSync(path.join(root, 'coverage'), { recursive: true });
  writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), JSON.stringify(coverage));
}

function twoFnProject() {
  const root = project({ 'src/lib.js': TWO_SRC });
  writeCoverage(root, [2, 6]);
  return root;
}

function cacheFile(root) {
  return path.join(root, MUTATION_CACHE_FILE_NAME);
}

// A counting fake runner with a fixed verdict; `decide` reads the current
// (mutated) source when the verdict must depend on the applied mutant.
function fakeRunner(decide = () => KILLED) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: (root, timeoutMs) => {
      calls++;
      return decide(readFileSync(path.join(root, 'src/lib.js'), 'utf8'));
    },
  };
}

// One gate-run-shaped invocation: the real scan + cache binding, fake
// per-mutant runner (mirrors the real suite's verdict role).
function runGate(root, opts, runner) {
  return mutationViolations([path.join(root, 'src/lib.js')], root, opts, { runner: runner.run });
}

function fromCacheCount(result) {
  return result.outcomes.filter((o) => o.fromCache).length;
}

// ---------------------------------------------------------------------------
// fnv1a64Hex

test('fnv1a64Hex: deterministic, 16 hex chars, sensitive to any edit', () => {
  assert.equal(fnv1a64Hex('return a + b;'), fnv1a64Hex('return a + b;'));
  const digest = fnv1a64Hex('export function sign(n) { return n > 0 ? 1 : -1; }');
  assert.equal(digest.length, 16);
  assert.ok(/^[0-9a-f]{16}$/.test(digest));
  assert.notEqual(fnv1a64Hex('return a + b; '), fnv1a64Hex('return a + b;'));
  assert.notEqual(fnv1a64Hex('return a - b;'), fnv1a64Hex('return a + b;'));
});

test('cacheMetaCurrent: sorted operators and joined test args fingerprint', () => {
  assert.deepEqual(cacheMetaCurrent(['constant', 'arithmetic'], ['--test', '--reporter=dot']), {
    tool: META.tool,
    operators: 'arithmetic,constant',
    test_args: '--test,--reporter=dot',
  });
  assert.match(META.tool, /^crap4js \d/);
});

// ---------------------------------------------------------------------------
// MutationCache.replayKill

function cacheWith(status) {
  return new MutationCache(META, {
    [methodsKey('src/lib.js', 'add')]: {
      digest: 'd1',
      outcomes: [{ offset: 10, line: 3, category: 'arithmetic', original: '+', mutant: '-', status }],
    },
  });
}

function refFor(digest, start = 0) {
  return { key: methodsKey('src/lib.js', 'add'), digest, start };
}

const SITE = { offset: 10, line: 3, category: 'arithmetic', original: '+', mutant: '-' };

test('replayKill: replays a killed outcome on digest and site match', () => {
  const replay = cacheWith('killed').replayKill(refFor('d1'), SITE);
  assert.equal(replay.status, 'killed');
});

test('replayKill: never replays survivors or timeouts', () => {
  for (const status of ['survived', 'timeout']) {
    assert.equal(cacheWith(status).replayKill(refFor('d1'), SITE), null, status);
  }
});

test('replayKill: digest, key and site identity mismatches never replay', () => {
  const cache = cacheWith('killed');
  assert.equal(cache.replayKill(refFor('other'), SITE), null);
  assert.equal(
    cache.replayKill({ key: methodsKey('src/other.js', 'add'), digest: 'd1', start: 0 }, SITE),
    null,
  );
  assert.equal(cache.replayKill(refFor('d1'), { ...SITE, offset: 99 }), null);
  assert.equal(cache.replayKill(refFor('d1'), { ...SITE, mutant: '*' }), null);
});

test('replayKill: matches offsets relative to the method start', () => {
  // The site sits at absolute offset 20; the method starts at 10, so the
  // stored relative offset 10 matches only with start: 10.
  const cache = cacheWith('killed');
  const shifted = { ...SITE, offset: 20 };
  assert.notEqual(cache.replayKill(refFor('d1', 10), shifted), null);
  assert.equal(cache.replayKill(refFor('d1', 0), shifted), null);
});

// ---------------------------------------------------------------------------
// Persistence, meta guard, merge/prune

function populated() {
  return new MutationCache(META, {
    [methodsKey('src/lib.js', 'add')]: {
      digest: 'd1',
      outcomes: [{ offset: 5, line: 2, category: 'arithmetic', original: '+', mutant: '-', status: 'killed' }],
    },
    [methodsKey('src/other.js', 'add')]: {
      digest: 'd2',
      outcomes: [{ offset: 7, line: 4, category: 'constant', original: '>', mutant: '>=', status: 'survived' }],
    },
  });
}

test('persistence: round-trips through save/load', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-mcache-'));
  t.after(() => cleanup(root));
  const file = path.join(root, MUTATION_CACHE_FILE_NAME);
  populated().save(file);
  assert.deepEqual(MutationCache.load(file, META).methods, populated().methods);
  assert.deepEqual(MutationCache.load(file, META).meta, META);
});

test('persistence: a meta mismatch wipes the cache', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-mcache-'));
  t.after(() => cleanup(root));
  const file = path.join(root, MUTATION_CACHE_FILE_NAME);
  populated().save(file);
  const other = cacheMetaCurrent(['arithmetic'], ['--test', '--reporter=dot']);
  const loaded = MutationCache.load(file, other);
  assert.deepEqual(loaded.methods, {});
  assert.deepEqual(loaded.meta, other);
});

test('persistence: a corrupt file or wrong version yields an empty cache', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-mcache-'));
  t.after(() => cleanup(root));
  const file = path.join(root, MUTATION_CACHE_FILE_NAME);
  writeFileSync(file, '{not json at all');
  assert.deepEqual(MutationCache.load(file, META).methods, {});
  writeFileSync(file, JSON.stringify({ version: MUTATION_CACHE_VERSION + 1, meta: META, methods: { x: { digest: 'd', outcomes: [] } } }));
  assert.deepEqual(MutationCache.load(file, META).methods, {});
  assert.deepEqual(MutationCache.load(path.join(root, 'absent.json'), META).methods, {});
});

test('mergeRun: prunes vanished methods and unions fresh with kept outcomes', () => {
  const cache = populated();
  const fresh = new Map([
    [methodsKey('src/lib.js', 'add'), {
      digest: 'd1-new',
      outcomes: [{ offset: 9, line: 2, category: 'boundary', original: '>', mutant: '>=', status: 'killed' }],
    }],
  ]);
  cache.mergeRun(fresh, new Set([methodsKey('src/lib.js', 'add')]));
  // src/other.js vanished from the live set — pruned.
  const keys = Object.keys(cache.methods);
  assert.deepEqual(keys, [methodsKey('src/lib.js', 'add')]);
  const entry = cache.methods[methodsKey('src/lib.js', 'add')];
  assert.equal(entry.digest, 'd1-new');
  // Fresh outcomes win their site; the still-valid old killed outcome is kept.
  assert.equal(entry.outcomes.length, 2);
  assert.equal(entry.outcomes[0].category, 'boundary');
  assert.equal(entry.outcomes[1].status, 'killed');
});

// ---------------------------------------------------------------------------
// Gate-run integration: replay, survivors, invalidation, pruning

test('cache replay: second run makes zero runner calls for unchanged killed mutants', () => {
  const root = twoFnProject();
  try {
    const first = fakeRunner();
    const r1 = runGate(root, parseMutationArgs([]), first);
    assert.equal(first.calls, 2);
    assert.equal(r1.killed, 2);
    assert.equal(fromCacheCount(r1), 0);
    assert.ok(existsSync(cacheFile(root)));

    const second = fakeRunner();
    const r2 = runGate(root, parseMutationArgs([]), second);
    assert.equal(second.calls, 0, 'killed mutants of unchanged methods replay');
    assert.equal(r2.killed, 2);
    assert.equal(fromCacheCount(r2), 2);
    assert.equal(r2.score, r1.score, 'identical verdicts');
    // The replayed outcomes keep their sites, so the cache stays stable.
    const stored = JSON.parse(readFileSync(cacheFile(root), 'utf8'));
    assert.equal(stored.version, MUTATION_CACHE_VERSION);
    assert.deepEqual(Object.keys(stored.methods), [methodsKey('src/lib.js', 'add'), methodsKey('src/lib.js', 'zero')].sort());
  } finally {
    cleanup(root);
  }
});

test('cache replay: survivors are always re-executed on the second run', () => {
  const root = twoFnProject();
  try {
    // The suite misses exactly the `0` -> `1` mutant in `zero`.
    const first = fakeRunner((src) => (src.includes('return 1;') ? SURVIVED : KILLED));
    const r1 = runGate(root, parseMutationArgs([]), first);
    assert.equal(r1.killed, 1);
    assert.equal(r1.survived, 1);

    const second = fakeRunner();
    const r2 = runGate(root, parseMutationArgs([]), second);
    assert.equal(second.calls, 1, 'only the survivor re-executes');
    assert.equal(fromCacheCount(r2), 1);
    assert.equal(r2.killed, 2);
    assert.equal(r2.survived, 0);
  } finally {
    cleanup(root);
  }
});

test('cache invalidation: an edit inside a method re-executes only its mutants', () => {
  const root = twoFnProject();
  try {
    const first = fakeRunner();
    const r1 = runGate(root, parseMutationArgs([]), first);
    assert.equal(r1.killed, 2);

    // Add a comment inside `add` only; `zero` stays untouched (its absolute
    // site offset shifts, its method text — and digest — does not).
    writeFileSync(path.join(root, 'src/lib.js'), TWO_EDITED);
    writeCoverage(root, [3, 7]);
    const second = fakeRunner();
    const r2 = runGate(root, parseMutationArgs([]), second);
    assert.equal(second.calls, 1, 'only add changed; zero replays from cache');
    assert.equal(fromCacheCount(r2), 1);
    assert.equal(r2.killed, 2);
  } finally {
    cleanup(root);
  }
});

test('cache invalidation: an operator or test_args meta change wipes everything', () => {
  const root = twoFnProject();
  try {
    const cold = fakeRunner();
    const r1 = runGate(root, parseMutationArgs([]), cold);
    assert.equal(r1.killed, 2);

    // Different operator set -> different meta -> full re-execution (and
    // only the constant site is even detected under the subset).
    const subset = fakeRunner();
    const r2 = runGate(root, parseMutationArgs(['--operators', 'constant']), subset);
    assert.equal(subset.calls, 1, 'no replay under a changed meta');
    assert.equal(fromCacheCount(r2), 0);

    // Same source, changed test_args -> meta mismatch -> re-execution.
    const scoped = parseMutationArgs(['--test-args', '--reporter=dot']);
    assert.deepEqual(scoped.testArgs, ['--test', '--reporter=dot']);
    const third = fakeRunner();
    const r3 = runGate(root, scoped, third);
    assert.equal(third.calls, 2, 'test_args are part of the meta guard');
    assert.equal(fromCacheCount(r3), 0);
  } finally {
    cleanup(root);
  }
});

test('--no-cache re-executes everything and leaves the cache file untouched', () => {
  const root = twoFnProject();
  try {
    const cold = fakeRunner();
    runGate(root, parseMutationArgs([]), cold);
    assert.ok(existsSync(cacheFile(root)));
    const before = readFileSync(cacheFile(root), 'utf8');

    const nocache = fakeRunner();
    const r2 = runGate(root, parseMutationArgs(['--no-cache']), nocache);
    assert.equal(nocache.calls, 2);
    assert.equal(fromCacheCount(r2), 0);
    assert.equal(readFileSync(cacheFile(root), 'utf8'), before, 'no cache write without a session');

    // ...and the untouched cache still replays afterwards.
    const warm = fakeRunner();
    const r3 = runGate(root, parseMutationArgs([]), warm);
    assert.equal(warm.calls, 0);
    assert.equal(fromCacheCount(r3), 2);
  } finally {
    cleanup(root);
  }
});

test('methods sharing a name across files are keyed independently', () => {
  // Literal-free bodies: exactly two sites per file (the `>`/`<` rows).
  const A_SRC = 'export function cmp(a, b) {\n  return a > b;\n}\n';
  const B_SRC = 'export function cmp(a, b) {\n  return a < b;\n}\n';
  const root = project({ 'src/a.js': A_SRC, 'src/b.js': B_SRC });
  try {
    // Coverage marks both files' method lines.
    const coverage = {
      [path.join(root, 'src', 'a.js')]: { statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } } }, s: { 0: 1 } },
      [path.join(root, 'src', 'b.js')]: { statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } } }, s: { 0: 1 } },
    };
    mkdirSync(path.join(root, 'coverage'), { recursive: true });
    writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), JSON.stringify(coverage));
    // Kill everything in a.js, let all of b.js survive: the fake suite only
    // "notices" mutants of a.js.
    let firstCalls = 0;
    const first = {
      run: (r) => {
        firstCalls++;
        return readFileSync(path.join(r, 'src/a.js'), 'utf8') === A_SRC ? SURVIVED : KILLED;
      },
    };
    const files = [path.join(root, 'src/a.js'), path.join(root, 'src/b.js')];
    const r1 = mutationViolations(files, root, parseMutationArgs([]), { runner: first.run });
    assert.equal(firstCalls, 4);
    assert.equal(r1.killed, 2);
    assert.equal(r1.survived, 2);

    const second = {
      run: () => {
        throw new Error('second run should replay everything');
      },
    };
    // a.js replays; only b.js survivors re-execute — and now they die.
    let secondCalls = 0;
    second.run = () => {
      secondCalls++;
      return KILLED;
    };
    const r2 = mutationViolations(files, root, parseMutationArgs([]), { runner: second.run });
    assert.equal(secondCalls, 2, 'only b.js survivors re-execute; a.js replays');
    assert.equal(r2.killed, 4);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Tree integrity (crap4dart 8b2e8e8)

test('integrity: multi-site run leaves every file byte-identical, no violations', () => {
  const root = twoFnProject();
  try {
    const file = path.join(root, 'src/lib.js');
    const sites = sitesOf(root);
    const { outcomes, integrityViolations } = runEngine(root, sites, 1000, fakeRunner().run);
    assert.equal(outcomes.length, 2);
    assert.deepEqual(integrityViolations, []);
    assert.equal(readFileSync(file, 'utf8'), TWO_SRC);
  } finally {
    cleanup(root);
  }
});

test('integrity: an exception mid-loop still leaves every file byte-identical', () => {
  const root = twoFnProject();
  try {
    const file = path.join(root, 'src/lib.js');
    let call = 0;
    assert.throws(
      () => runEngine(root, sitesOf(root), 1000, () => {
        call++;
        if (call === 2) throw new Error('runner exploded');
        return KILLED;
      }),
      /runner exploded/,
    );
    assert.equal(readFileSync(file, 'utf8'), TWO_SRC);
  } finally {
    cleanup(root);
  }
});

test('integrity: an out-of-band write is re-restored and reported', () => {
  // The fa_llm incident, in-process: while `a` is being mutated, the runner
  // writes junk over the OTHER tracked file, defeating that file's later
  // per-site restore (executeSite treats the junk as its "original"). The
  // end-of-run tree check must re-restore it and surface the violation.
  const root = project({ 'src/a.js': ONE_A, 'src/b.js': ONE_B });
  try {
    const bFile = path.join(root, 'src/b.js');
    let call = 0;
    const result = runEngine(root, twoFileSites(root), 1000, () => {
      call++;
      if (call === 1) writeFileSync(bFile, 'export const junk = "out-of-band";\n');
      return KILLED;
    });
    assert.deepEqual(result.integrityViolations, [bFile]);
    assert.equal(readFileSync(path.join(root, 'src/a.js'), 'utf8'), ONE_A);
    assert.equal(readFileSync(bFile, 'utf8'), ONE_B, 'the tree healed itself');
  } finally {
    cleanup(root);
  }
});

test('integrity: the gate surfaces INTEGRITY in the summary for re-restored files', () => {
  const root = project({ 'src/a.js': ONE_A, 'src/b.js': ONE_B });
  try {
    const bFile = path.join(root, 'src/b.js');
    const coverage = {};
    for (const name of ['a.js', 'b.js']) {
      coverage[path.join(root, 'src', name)] = {
        statementMap: { 0: { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } } },
        s: { 0: 1 },
      };
    }
    mkdirSync(path.join(root, 'coverage'), { recursive: true });
    writeFileSync(path.join(root, 'coverage', 'coverage-final.json'), JSON.stringify(coverage));
    let call = 0;
    const runner = {
      run: (r) => {
        call++;
        if (call === 1) writeFileSync(path.join(r, 'src/b.js'), 'export const junk = "out-of-band";\n');
        return KILLED;
      },
    };
    const files = [path.join(root, 'src/a.js'), path.join(root, 'src/b.js')];
    const result = mutationViolations(files, root, parseMutationArgs([]), { runner: runner.run });
    assert.deepEqual(result.integrityViolations, ['src/b.js']);
    assert.match(mutationSummary(result), /INTEGRITY: re-restored after run: src\/b\.js/);
    assert.equal(readFileSync(bFile, 'utf8'), ONE_B);
  } finally {
    cleanup(root);
  }
});

const ONE_A = 'export function add(a, b) {\n  return a + b;\n}\n';
const ONE_B = 'export function zero() {\n  return 0;\n}\n';

// Sites of the one-site-per-file fixture with file/rel/method bound — the
// shape runEngine consumes (what selectSites normally produces).
function twoFileSites(root) {
  const a = path.join(root, 'src/a.js');
  const b = path.join(root, 'src/b.js');
  return [
    { line: 2, offset: ONE_A.indexOf('+'), length: 1, category: 'arithmetic', original: '+', mutant: '%', file: a, rel: 'src/a.js', method: 'add' },
    { line: 2, offset: ONE_B.indexOf('0', ONE_B.indexOf('return')), length: 1, category: 'constant', original: '0', mutant: '1', file: b, rel: 'src/b.js', method: 'zero' },
  ];
}

// Sites of the two-function fixture with file/rel/method bound — the shape
// runEngine consumes (what selectSites normally produces).
function sitesOf(root) {
  const file = path.join(root, 'src/lib.js');
  return [
    { line: 2, offset: TWO_SRC.indexOf('+'), length: 1, category: 'arithmetic', original: '+', mutant: '%', file, rel: 'src/lib.js', method: 'add' },
    { line: 6, offset: TWO_SRC.indexOf('0', TWO_SRC.indexOf('return 0')), length: 1, category: 'constant', original: '0', mutant: '1', file, rel: 'src/lib.js', method: 'zero' },
  ];
}

// ---------------------------------------------------------------------------
// Arg surface

test('parseMutationArgs: --cache/--no-cache flip, --test-args accumulates, validation', () => {
  assert.equal(parseMutationArgs(['--no-cache']).cache, false);
  assert.equal(parseMutationArgs(['--no-cache', '--cache']).cache, true);
  assert.deepEqual(parseMutationArgs(['--test-args', '--test-only']).testArgs, ['--test', '--test-only']);
  assert.deepEqual(parseMutationArgs(['--test-args=--test', '--test-args=test/main.test.js']).testArgs, ['--test', '--test', 'test/main.test.js']);
  assert.throws(() => parseMutationArgs(['--test-args', '']), /--test-args arguments must be non-empty strings/);
  assert.throws(() => parseMutationArgs(['--no-cache=x']), /unknown flag: --no-cache/);
});

test('runMutantTests args: the gate binds testArgs into the default runner', () => {
  const seen = [];
  const spawn = (exe, args) => {
    seen.push([exe, args]);
    return { status: 0 };
  };
  runMutantTests('.', 1000, spawn, ['--test', '--test-only']);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0][1], ['--test', '--test-only']);
  runMutantTests('.', 1000, spawn);
  assert.deepEqual(seen[1][1], ['--test']);
});
