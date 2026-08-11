import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURES = path.resolve(__dirname, 'fixtures');

function runCli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function buildProject({ source, coverage }) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-cli-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'coverage'));
  const sourcePath = path.join(root, 'src', path.basename(source));
  cpSync(source, sourcePath);
  // Build coverage JSON keyed by the actual temp file path so loadCoverage
  // can relativize against the temp project root.
  const coverageData =
    typeof coverage === 'function' ? coverage(sourcePath) : coverage;
  writeFileSync(
    path.join(root, 'coverage', 'coverage-final.json'),
    JSON.stringify(coverageData),
  );
  return root;
}

function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

test('--help prints usage and exits 0', () => {
  const r = runCli(process.cwd(), ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /--changed/);
});

test('unknown flag exits 1', () => {
  const r = runCli(process.cwd(), ['--bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Usage:/);
});

test('--changed combined with explicit path exits 1', () => {
  const r = runCli(process.cwd(), ['--changed', 'src/foo.js']);
  assert.equal(r.status, 1);
});

test('--threshold without value exits 1', () => {
  const r = runCli(process.cwd(), ['--threshold']);
  assert.equal(r.status, 1);
});

test('non-numeric threshold exits 1', () => {
  const r = runCli(process.cwd(), ['--threshold', 'abc']);
  assert.equal(r.status, 1);
});

test('no src/ directory -> "No JavaScript files to analyze." exit 0', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'crap4js-empty-'));
  try {
    const r = runCli(empty, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No JavaScript files to analyze\./);
  } finally {
    cleanup(empty);
  }
});

test('fixture with full coverage prints CRAP report, exit 0', () => {
  const root = buildProject({
    source: path.join(FIXTURES, 'sample.js'),
    coverage: (sourcePath) => ({
      [sourcePath]: {
        statementMap: {
          '0': {
            start: { line: 3, column: 0 },
            end: { line: 5, column: 1 },
          },
          '1': {
            start: { line: 4, column: 2 },
            end: { line: 4, column: 14 },
          },
          '2': {
            start: { line: 5, column: 2 },
            end: { line: 5, column: 12 },
          },
        },
        s: { '0': 1, '1': 1, '2': 1 },
      },
    }),
  });
  try {
    const r = runCli(root, []);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /CRAP Report/);
    assert.match(r.stdout, /addPositive/);
    assert.match(r.stdout, /Max CRAP:/);
  } finally {
    cleanup(root);
  }
});

test('fixture with high complexity + zero coverage exits 2', () => {
  const root = buildProject({
    source: path.join(FIXTURES, 'high_crap.js'),
    coverage: (sourcePath) => ({
      [sourcePath]: {
        statementMap: {
          '0': {
            start: { line: 5, column: 0 },
            end: { line: 13, column: 1 },
          },
        },
        s: { '0': 0 },
      },
    }),
  });
  try {
    const r = runCli(root, []);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /CRAP threshold exceeded/);
  } finally {
    cleanup(root);
  }
});

test('missing coverage file still produces a report with N/A entries', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-nocov-'));
  mkdirSync(path.join(root, 'src'));
  try {
    cpSync(
      path.join(FIXTURES, 'sample.js'),
      path.join(root, 'src', 'sample.js'),
    );
    const r = runCli(root, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /CRAP Report/);
    assert.match(r.stdout, /N\/A/);
    assert.match(r.stderr, /coverage file not found/);
  } finally {
    cleanup(root);
  }
});

test('explicit positional path is analyzed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-explicit-'));
  try {
    mkdirSync(path.join(root, 'lib'));
    cpSync(
      path.join(FIXTURES, 'sample.js'),
      path.join(root, 'lib', 'sample.js'),
    );
    const r = runCli(root, ['lib/sample.js']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /addPositive/);
  } finally {
    cleanup(root);
  }
});
