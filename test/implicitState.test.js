import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  implicitStateViolations,
  implicitStateSummary,
  runImplicitState,
} from '../src/implicitState.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function fakeCtx(cwd) {
  const out = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    lines: out,
  };
}

function fixture(name, source) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-implicit-state-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', name), `${source}\n`);
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function resultOf(name, source, opts) {
  const root = fixture(name, source);
  try {
    return implicitStateViolations([path.join(root, 'src', name)], root, opts);
  } finally {
    cleanup(root);
  }
}

function violationsOf(name, source, opts) {
  return resultOf(name, source, opts).violations;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

// --- Check 1: scattered lifecycle flag --------------------------------------

const ONE_FLAG_SRC = `class Job {
  isDone = false;

  run() {
    this.isDone = false;
  }

  complete() {
    this.isDone = true;
  }

  reset() {
    this.isDone = false;
  }
}`;

test('flags a lifecycle flag mutated from many places', () => {
  const v = violationsOf('a.js', ONE_FLAG_SRC);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2); // the field declaration line
  assert.match(v[0].message, /lifecycle flag 'isDone' is mutated from 3 places/);
});

test('one mutation site stays below the default min_mutators', () => {
  const src = `class Once {
  isStarted = false;

  start() {
    this.isStarted = true;
  }
}`;
  assert.deepEqual(violationsOf('a.js', src), []);
});

test('min_mutators 1 reports a single-place mutation', () => {
  const src = `class Once {
  isStarted = false;

  start() {
    this.isStarted = true;
  }
}`;
  const v = violationsOf('a.js', src, { minMutators: 1 });
  assert.equal(v.length, 1);
  assert.match(v[0].message, /mutated from 1 places/);
});

test('bare and computed assignments are not field writes', () => {
  const src = `class Bare {
  isReady = false;

  a() {
    isReady = true; // not a field write in JS — a global/undeclared var
    this['isReady'] = false; // computed: invisible to a name-shape scan
    other.isReady = true; // counts — any receiver, name-shape only
  }

  b() {
    other.isReady = false;
  }
}`;
  const v = violationsOf('a.js', src);
  // Only the two member writes through `other.` count: 2 distinct mutators.
  assert.equal(v.length, 1);
  assert.match(v[0].message, /mutated from 2 places/);
});

// --- Check 2: scattered status field ----------------------------------------

const STATUS_SRC = `class Job {
  status = 'idle';

  run() {
    this.status = 'running';
  }

  finish() {
    this.status = 'done';
  }
}`;

test('flags a status field assigned from several methods', () => {
  const v = violationsOf('a.js', STATUS_SRC);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /status field 'status' is mutated from 2 places — implicit transitions; centralize them/);
});

// --- Check 3: boolean-cluster state machine ---------------------------------

const CLUSTER_SRC = `class Downloader {
  isRunning = false;
  hasFailed = false;
  isDisposed = false;

  start() {
    this.isRunning = true;
    this.hasFailed = false;
  }

  stop() {
    this.isRunning = false;
    this.isDisposed = true;
  }

  fail() {
    this.hasFailed = true;
    this.isRunning = false;
  }
}`;

test('flags a lifecycle-flag cluster mutated across methods', () => {
  const v = violationsOf('a.js', CLUSTER_SRC);
  const cluster = v.filter((x) => x.message.includes('boolean-cluster'));
  assert.equal(cluster.length, 1);
  assert.equal(cluster[0].line, 1); // the class declaration line
  assert.match(cluster[0].message, /class holds 3 lifecycle flags mutated across methods/);
});

test('respects min_flags for the cluster finding', () => {
  const src = `class Small {
  isRunning = false;
  hasFailed = false;

  start() {
    this.isRunning = true;
    this.hasFailed = false;
  }

  stop() {
    this.isRunning = false;
    this.hasFailed = true;
  }
}`;
  const v = violationsOf('a.js', src, { minFlags: 3 });
  assert.deepEqual(v.filter((x) => x.message.includes('boolean-cluster')), []);
  // --min-flags 2 restores the cluster finding.
  const raised = violationsOf('a.js', src, { minFlags: 2 });
  assert.equal(raised.filter((x) => x.message.includes('boolean-cluster')).length, 1);
});

test('static and readonly fields are never lifecycle flags', () => {
  const src = `class Config {
  static isGlobalEnabled = false;
  isReady = true;

  a() {
    this.isReady = false;
    Config.isGlobalEnabled = true;
  }

  b() {
    Config.isGlobalEnabled = false;
  }
}`;
  // The STATIC flag is mutated from two members (a, b) through `Config.` —
  // with the exclusion dropped this would be a scattered finding. Instance
  // isReady has one mutator — nothing fires.
  assert.deepEqual(violationsOf('a.js', src), []);
});

test('TS readonly boolean fields are excluded, annotated fields count', () => {
  const src = `class Config {
  readonly isReady: boolean;
  isLoaded: boolean;

  a() {
    this.isReady = true;
    this.isLoaded = true;
  }

  b() {
    this.isReady = false;
    this.isLoaded = false;
  }
}`;
  const v = violationsOf('a.ts', src);
  // readonly isReady is mutated from two members and still invisible —
  // only the mutable annotated isLoaded flags.
  assert.equal(v.length, 1);
  assert.match(v[0].message, /lifecycle flag 'isLoaded' is mutated from 2 places/);
});

test('private methods count as mutators', () => {
  const src = `class Vault {
  isOpen = false;

  #open() {
    this.isOpen = true;
  }

  #close() {
    this.isOpen = false;
  }
}`;
  const v = violationsOf('a.js', src);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /lifecycle flag 'isOpen' is mutated from 2 places/);
});

test('TS ctor parameter properties are not declared fields (upstream parity)', () => {
  const src = `class Ctor {
  constructor(private isReady = false) {
    this.isReady = true;
  }

  b() {
    this.isReady = false;
  }
}`;
  // Upstream ignores Dart's `this.x` ctor-parameter fields (no
  // FieldDeclaration node); the port maps TS parameter properties the same
  // way — isReady is not a declared flag, so its writes never count.
  assert.deepEqual(violationsOf('a.ts', src), []);
});

test('non-state bool fields are ignored', () => {
  const src = `class Settings {
  verbose = false;
  colored = true;
  strict = false;

  toggle() {
    this.verbose = !this.verbose;
    this.colored = !this.colored;
    this.strict = !this.strict;
  }

  reset() {
    this.verbose = false;
    this.colored = true;
    this.strict = false;
  }
}`;
  assert.deepEqual(violationsOf('a.js', src), []);
});

// --- Check 4: flag-combination conditions -----------------------------------

const COMBO_SRC = `class Guard {
  isLoading = false;
  hasFailed = false;

  check(other) {
    if (this.isLoading && this.hasFailed) {
      return true;
    }
    return false;
  }
}`;

test('flags if-conditions branching on flag combinations', () => {
  const v = violationsOf('a.js', COMBO_SRC);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 6); // the if line
  assert.match(v[0].message, /condition branches on 2 lifecycle flags \(isLoading, hasFailed\) — an implicit state combination/);
});

test('other-object reads and single-flag conditions are not combos', () => {
  const src = `class Plain {
  isReady = false;

  check(other) {
    if (other.isReady) {
      return 1;
    }
    if (this.isReady) {
      return 2;
    }
    return 0;
  }
}`;
  assert.deepEqual(violationsOf('a.js', src), []);
});

test('an else-if is its own condition and counts', () => {
  const src = `class Chain {
  isRunning = false;
  hasFailed = false;

  check() {
    if (this.isRunning) {
      return 1;
    } else if (this.isRunning || this.hasFailed) {
      return 2;
    }
    return 0;
  }
}`;
  const v = violationsOf('a.js', src);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 8); // the else-if's own line
});

// --- Class scoping -----------------------------------------------------------

test('nested classes are separate scans', () => {
  const src = `class Outer {
  isReady = false;

  run() {
    const Inner = class {
      isDone = false;

      go() {
        this.isDone = true;
        this.isDone = false;
      }
    };
    return new Inner();
  }
}`;
  const r = resultOf('a.js', src);
  assert.equal(r.checked, 2); // Outer + the nested Inner, scanned separately
  assert.deepEqual(r.violations, []); // Inner's isDone has one mutator; Outer's isReady none
});

test('class expressions and a clean class pass', () => {
  const src = `const Clean = class {};`;
  const r = resultOf('a.js', src);
  assert.equal(r.checked, 1);
  assert.deepEqual(r.violations, []);
  assert.equal(implicitStateSummary({ violations: 0, checked: 1 }), '1 classes scanned, no implicit state machines');
  assert.equal(implicitStateSummary({ violations: 2, checked: 3 }), '2 implicit-state finding(s) (3 classes scanned)');
});

// --- Command plumbing --------------------------------------------------------

test('CLI: warning severity reports and exits 0; error severity exits 2', () => {
  const root = fixture('a.js', COMBO_SRC);
  try {
    const warn = runCli(root, ['implicit-state', 'src']);
    assert.equal(warn.status, 0);
    assert.match(warn.stdout, /condition branches on 2 lifecycle flags/);
    assert.match(warn.stdout, /1 implicit-state finding\(s\) \(1 classes scanned\)/);
    const err = runCli(root, ['implicit-state', '--severity', 'error', 'src']);
    assert.equal(err.status, 2);
  } finally {
    cleanup(root);
  }
});

test('CLI: unknown flags are usage errors', () => {
  const root = fixture('a.js', COMBO_SRC);
  try {
    const bad = runCli(root, ['implicit-state', '--min-flagz=3', 'src']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown flag: --min-flagz/);
    const badSeverity = runCli(root, ['implicit-state', '--severity', 'fatal']);
    assert.equal(badSeverity.status, 1);
    assert.match(badSeverity.stderr, /--severity must be warning or error/);
  } finally {
    cleanup(root);
  }
});

test('CLI: --min-flags/--min-mutators flatten the upstream config keys', () => {
  const root = fixture('a.js', CLUSTER_SRC);
  try {
    // min_mutators 4 silences the scattered findings; min_flags 9 silences
    // the cluster — the file reports clean.
    const strict = runCli(root, ['implicit-state', '--min-flags', '9', '--min-mutators', '4', 'src']);
    assert.equal(strict.status, 0);
    assert.match(strict.stdout, /no implicit state machines/);
  } finally {
    cleanup(root);
  }
});

test('CLI: findings honor ignore markers', () => {
  const root = fixture('a.js', `// ignore-file:implicit-state\n${COMBO_SRC}`);
  try {
    const r = runCli(root, ['implicit-state', 'src']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no implicit state machines/);
  } finally {
    cleanup(root);
  }
});

test('CLI: help lists the subcommand', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-implicit-state-help-'));
  try {
    const help = runCli(root, ['--help']);
    assert.match(help.stdout, /crap4js implicit-state \[--min-flags N\]/);
    const listed = runCli(root, ['implicit-state']);
    assert.ok(listed.stdout.length > 0);
  } finally {
    cleanup(root);
  }
});

test('module: runImplicitState passes through the shared runner', () => {
  const root = fixture('a.js', COMBO_SRC);
  try {
    const code = runImplicitState(['src'], fakeCtx(root));
    assert.equal(code, 0); // warning severity: findings print, exit 0
  } finally {
    cleanup(root);
  }
});
