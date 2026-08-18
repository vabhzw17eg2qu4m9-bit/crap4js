import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { changedFiles, isChangeStatus, parseStatusLine, isTestFile, testFiles } from '../src/files.js';

// ---------- isChangeStatus ----------

test('isChangeStatus: true for M/A/R/C/?', () => {
  for (const c of ['M', 'A', 'R', 'C', '?']) {
    assert.equal(isChangeStatus(c), true, `expected ${c} to be a change status`);
  }
});

test('isChangeStatus: false for space, D, and other chars', () => {
  for (const c of [' ', 'D', 'X', 'm', '']) {
    assert.equal(isChangeStatus(c), false, `expected ${JSON.stringify(c)} to be false`);
  }
});

// ---------- parseStatusLine ----------

const ROOT = path.join(os.tmpdir(), 'crap4js-parse-proj');
const SRC = path.join(ROOT, 'src');

test('parseStatusLine: null for blank / short lines', () => {
  assert.equal(parseStatusLine('', ROOT, SRC), null);
  assert.equal(parseStatusLine('??', ROOT, SRC), null);
  assert.equal(parseStatusLine('abc', ROOT, SRC), null);
});

test('parseStatusLine: null for non-source extension', () => {
  assert.equal(parseStatusLine('M  src/notes.txt', ROOT, SRC), null);
  assert.equal(parseStatusLine('?? src/data.json', ROOT, SRC), null);
  assert.equal(parseStatusLine('A  src/README.md', ROOT, SRC), null);
});

test('parseStatusLine: null for path outside src/', () => {
  assert.equal(parseStatusLine('M  lib/x.js', ROOT, SRC), null);
  assert.equal(parseStatusLine('?? README.md', ROOT, SRC), null);
});

test('parseStatusLine: null for deletions (no change-status letter)', () => {
  // "D " in column X, space in Y → neither is a kept status letter.
  assert.equal(parseStatusLine('D  src/gone.js', ROOT, SRC), null);
});

test('parseStatusLine: resolves staged modified source path', () => {
  assert.equal(
    parseStatusLine('M  src/a.js', ROOT, SRC),
    path.join(ROOT, 'src/a.js'),
  );
});

test('parseStatusLine: resolves untracked source path', () => {
  assert.equal(
    parseStatusLine('?? src/b.js', ROOT, SRC),
    path.join(ROOT, 'src/b.js'),
  );
});

test('parseStatusLine: resolves nested source path (.mjs/.cjs)', () => {
  assert.equal(
    parseStatusLine('A  src/sub/c.mjs', ROOT, SRC),
    path.join(ROOT, 'src/sub/c.mjs'),
  );
  assert.equal(
    parseStatusLine('C  src/sub/d.cjs', ROOT, SRC),
    path.join(ROOT, 'src/sub/d.cjs'),
  );
});

test('parseStatusLine: rename resolves to the target path', () => {
  assert.equal(
    parseStatusLine('R  src/old.js -> src/new.js', ROOT, SRC),
    path.join(ROOT, 'src/new.js'),
  );
});

test('parseStatusLine: worktree-only status (" M") still resolves', () => {
  // Column X is a space (nothing staged), column Y is M (worktree modified).
  assert.equal(
    parseStatusLine(' M src/x.js', ROOT, SRC),
    path.join(ROOT, 'src/x.js'),
  );
});

// ---------- changedFiles (real git subprocess) ----------

function git(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (e) {
    throw new Error(
      `git ${args.join(' ')} in ${root} failed: ${e.stderr || e.message}`,
    );
  }
}

function makeRepo(root) {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'commit.gpgsign', 'false');
}

test('changedFiles: real git repo — modified, renamed, untracked; junk excluded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crap4js-changed-'));
  try {
    makeRepo(root);

    const writeSrc = (rel, body) => {
      const p = path.join(root, 'src', rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    // Seed files: tracked (will be modified), other (committed, left clean),
    // renamed (committed, then git-mv'd), untracked (never added). notes.txt
    // exercises the non-source extension filter.
    writeSrc('tracked.js', 'export const a = 1;\n');
    writeSrc('other.js', 'export const b = 1;\n');
    writeSrc('renamed.js', 'export const c = 1;\n');
    writeSrc('untracked.js', 'export const d = 1;\n');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'hi\n');

    git(root, 'add', 'src/tracked.js', 'src/other.js', 'src/renamed.js');
    git(root, 'commit', '-qm', 'seed');

    // Modify tracked.js in the worktree, stage a rename renamed.js -> renamed2.js.
    fs.writeFileSync(path.join(root, 'src/tracked.js'), 'export const a = 2;\n');
    git(root, 'mv', 'src/renamed.js', 'src/renamed2.js');

    const got = changedFiles(root);
    // Expected: tracked.js (M), renamed2.js (R target), untracked.js (??).
    // other.js is clean (not reported); notes.txt is non-source (filtered).
    const want = [
      path.join(root, 'src/renamed2.js'),
      path.join(root, 'src/tracked.js'),
      path.join(root, 'src/untracked.js'),
    ].sort();
    assert.deepEqual(got, want);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changedFiles: throws when git status fails (not a git repo)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crap4js-nogit-'));
  try {
    assert.throws(() => changedFiles(root), /git status failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- isTestFile ----------

test('isTestFile: true for *.spec/*.test across js/jsx/ts/tsx and __tests__/', () => {
  for (const p of [
    'src/foo.spec.js',
    'src/foo.test.js',
    'src/foo.spec.jsx',
    'src/foo.test.jsx',
    'src/foo.spec.ts',
    'src/foo.test.ts',
    'src/foo.spec.tsx',
    'src/foo.test.tsx',
    'src/__tests__/thing.js',
    'src/a/__tests__/b/sub.js',
  ]) {
    assert.equal(isTestFile(p), true, `expected ${p} to be a test file`);
  }
});

test('isTestFile: false for production source', () => {
  for (const p of [
    'src/foo.js',
    'src/foo.jsx',
    'src/foo.ts',
    'src/foo.tsx',
    'src/components/Card.jsx',
    'src/spec.js',
    'src/test.js',
  ]) {
    assert.equal(isTestFile(p), false, `expected ${p} to NOT be a test file`);
  }
});

// ---------- testFiles ----------

test('testFiles default: <root>/test/ walk plus colocated tests under src/', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crap4js-testfiles-'));
  try {
    fs.mkdirSync(path.join(root, 'test', 'unit'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'test', 'a.test.js'), '');
    fs.writeFileSync(path.join(root, 'test', 'unit', 'b.test.js'), '');
    fs.writeFileSync(path.join(root, 'test', 'helper.js'), '');
    fs.writeFileSync(path.join(root, 'src', 'app.js'), '');
    fs.writeFileSync(path.join(root, 'src', 'colocated.test.js'), '');
    const rel = testFiles([], root).map((f) => path.relative(root, f));
    assert.deepEqual(rel, [
      'src/colocated.test.js',
      'test/a.test.js',
      'test/helper.js',
      'test/unit/b.test.js',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('testFiles explicit path keeps test files verbatim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crap4js-testfiles-'));
  try {
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'test', 'a.test.js'), '');
    const rel = testFiles(['test/a.test.js'], root).map((f) => path.relative(root, f));
    assert.deepEqual(rel, ['test/a.test.js']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
