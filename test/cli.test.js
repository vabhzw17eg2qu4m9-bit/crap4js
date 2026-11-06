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
  assert.match(r.stdout, /test-assertions/);
  assert.match(r.stdout, /folder-structure/);
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

// --- fail-closed coverage input (default; promoted from --strict) ---

test('missing coverage file exits 1 with an actionable error and no report', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-nocov-'));
  mkdirSync(path.join(root, 'src'));
  try {
    cpSync(
      path.join(FIXTURES, 'sample.js'),
      path.join(root, 'src', 'sample.js'),
    );
    const r = runCli(root, []);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /CRAP Report/);
    assert.match(r.stderr, /coverage file not found/);
    assert.match(r.stderr, /npx c8 --reporter=json node --test/);
  } finally {
    cleanup(root);
  }
});

test('zero-record lcov coverage exits 1 without --strict', () => {
  const root = strictProject({ coverageContent: 'TN:\n', coverageName: 'lcov.info' });
  try {
    const r = runCli(root, ['--coverage', 'coverage/lcov.info']);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /CRAP Report/);
    assert.match(r.stderr, /no records/);
    assert.match(r.stderr, /npx c8 --reporter=json node --test/);
  } finally {
    cleanup(root);
  }
});

test('unparseable coverage exits 1 without --strict', () => {
  const root = strictProject({
    coverageContent: 'TN:\nSF:src/sample.js\nDA:oops\nend_of_record\n',
    coverageName: 'lcov.info',
  });
  try {
    const r = runCli(root, ['--coverage', 'coverage/lcov.info']);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /CRAP Report/);
    assert.match(r.stderr, /failed to parse coverage file/);
  } finally {
    cleanup(root);
  }
});

test('explicit positional path is analyzed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-explicit-'));
  try {
    mkdirSync(path.join(root, 'lib'));
    const src = path.join(root, 'lib', 'sample.js');
    cpSync(path.join(FIXTURES, 'sample.js'), src);
    mkdirSync(path.join(root, 'coverage'));
    writeFileSync(
      path.join(root, 'coverage', 'coverage-final.json'),
      JSON.stringify({
        [src]: {
          statementMap: {
            '0': { start: { line: 5, column: 0 }, end: { line: 5, column: 0 } },
            '1': { start: { line: 6, column: 0 }, end: { line: 6, column: 0 } },
          },
          s: { '0': 1, '1': 1 },
        },
      }),
    );
    const r = runCli(root, ['lib/sample.js']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /addPositive/);
  } finally {
    cleanup(root);
  }
});

test('gate subcommands dispatch on the first argument', () => {
  const r = runCli(process.cwd(), ['banned-imports']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no rules configured/);
});

test('whole-project gate skips on explicit path selection (exit 0)', () => {
  const r = runCli(process.cwd(), ['unused-files', 'src']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not meaningful for a partial selection/);
});

test('banned-imports usage error exits 1', () => {
  const r = runCli(process.cwd(), ['banned-imports', '--from', 'a']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--from\/--forbid must come in pairs/);
});

test('nesting violation over an explicit file exits 2', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-gate-'));
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(
      path.join(root, 'src', 'deep.js'),
      'function d(a) { if (a) { if (a) { if (a) { if (a) { if (a) {} } } } } }\n',
    );
    const r = runCli(root, ['nesting', 'src/deep.js']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /d nesting=6 > max 5/);
  } finally {
    cleanup(root);
  }
});

const CHAIN_SRC = `function classify(x) {
  if (x < 0) { return 'neg'; }
  else if (x === 0) { return 'zero'; }
  else if (x < 10) { return 'small'; }
  else if (x < 100) { return 'medium'; }
  return 'large';
}
module.exports = classify;
`;

test('invalid --metric exits 1', () => {
  const r = runCli(process.cwd(), ['--metric', 'sonar']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid metric: sonar/);
});

test('--metric cognitive relabels the complexity column; default stays CC', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-metric-'));
  try {
    mkdirSync(path.join(root, 'src'));
    const src = path.join(root, 'src', 'chain.js');
    writeFileSync(src, CHAIN_SRC);
    mkdirSync(path.join(root, 'coverage'));
    writeFileSync(
      path.join(root, 'coverage', 'coverage-final.json'),
      JSON.stringify({
        [src]: {
          statementMap: {
            '0': { start: { line: 1, column: 0 }, end: { line: 6, column: 0 } },
          },
          s: { '0': 1 },
        },
      }),
    );
    const cognitive = runCli(root, ['--metric', 'cognitive', 'src/chain.js']);
    assert.equal(cognitive.status, 0, `stderr: ${cognitive.stderr}`);
    assert.match(cognitive.stdout, /\bCogn\b/);
    assert.doesNotMatch(cognitive.stdout, /\bCC\b/);
    const cyclomatic = runCli(root, ['src/chain.js']);
    assert.equal(cyclomatic.status, 0, `stderr: ${cyclomatic.stderr}`);
    assert.match(cyclomatic.stdout, /\bCC\b/);
    assert.doesNotMatch(cyclomatic.stdout, /\bCogn\b/);
  } finally {
    cleanup(root);
  }
});

test('--metric cognitive feeds the CRAP formula and exits 2', () => {
  const sourceFile = path.join(tmpdir(), 'crap4js-chain-src.js');
  writeFileSync(sourceFile, CHAIN_SRC);
  const root = buildProject({
    source: sourceFile,
    coverage: (sourcePath) => ({
      [sourcePath]: {
        statementMap: {
          '0': {
            start: { line: 1, column: 0 },
            end: { line: 6, column: 0 },
          },
        },
        s: { '0': 0 },
      },
    }),
  });
  try {
    // 4-way else-if chain: Cogn 4 → CRAP 4^2 * 1 + 4 = 20.0 > 8.0
    // (same fixture under the default metric: CC 5 → 30.0).
    const r = runCli(root, ['--metric', 'cognitive']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /CRAP threshold exceeded: 20\.0 > 8\.0/);
    assert.match(r.stdout, /\bCogn\b/);
  } finally {
    cleanup(root);
    rmSync(sourceFile, { force: true });
  }
});

// --- lcov coverage input (issue #79) ---

test('lcov .info report is byte-identical to the Istanbul JSON report of the same data', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-lcoveq-'));
  try {
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'coverage'));
    const src = path.join(root, 'src', 'sample.js');
    cpSync(path.join(FIXTURES, 'sample.js'), src);
    // One synthetic coverage run: addPositive's statements (lines 5, 6) hit,
    // identity's (line 12) not — expressed in both formats.
    const hits = [[5, 1], [6, 1], [12, 0]];
    const statementMap = {};
    const s = {};
    for (const [i, [line, count]] of hits.entries()) {
      statementMap[String(i)] = { start: { line, column: 0 }, end: { line, column: 0 } };
      s[String(i)] = count;
    }
    writeFileSync(
      path.join(root, 'coverage', 'coverage-final.json'),
      JSON.stringify({ [src]: { statementMap, s } }),
    );
    writeFileSync(
      path.join(root, 'coverage', 'lcov.info'),
      ['TN:', `SF:${src}`, ...hits.map(([l, c]) => `DA:${l},${c}`), 'LF:3', 'LH:2', 'end_of_record', ''].join('\n'),
    );
    const istanbul = runCli(root, ['--coverage', 'coverage/coverage-final.json']);
    const lcov = runCli(root, ['--coverage', 'coverage/lcov.info']);
    assert.equal(lcov.status, istanbul.status, `stderr: ${lcov.stderr}`);
    assert.equal(lcov.status, 0);
    assert.equal(lcov.stdout, istanbul.stdout);
    assert.equal(lcov.stderr, istanbul.stderr);
  } finally {
    cleanup(root);
  }
});

// --- --diff-base (issue #79) ---

function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function gitProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-git-'));
  mkdirSync(path.join(root, 'src'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  // Coverage is required input for every analyze run; the diff-base tests'
  // intent is function selection, so a record inside the root suffices
  // (files without their own entry just report N/A rows).
  mkdirSync(path.join(root, 'coverage'));
  writeFileSync(
    path.join(root, 'coverage', 'coverage-final.json'),
    JSON.stringify({
      [path.join(root, 'src', 'placeholder.js')]: {
        statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } } },
        s: { '0': 1 },
      },
    }),
  );
  return root;
}

const BASE_FNS = `function changed() {
  return 1;
}
function deletedOnly() {
  return 2;
}
function untouched() {
  return 3;
}
`;
const AFTER_FNS = `function changed() {
  return 11;
}
function deletedOnly() {
}
function untouched() {
  return 3;
}
`;

test('--diff-base keeps only the functions with an added/changed line', () => {
  const root = gitProject();
  try {
    const src = path.join(root, 'src', 'fns.js');
    writeFileSync(src, BASE_FNS);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    writeFileSync(src, AFTER_FNS);
    const r = runCli(root, ['--diff-base', 'HEAD']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /\bchanged\b/);
    // The deleted-lines-only function and the untouched one are dropped.
    assert.doesNotMatch(r.stdout, /deletedOnly/);
    assert.doesNotMatch(r.stdout, /untouched/);
  } finally {
    cleanup(root);
  }
});

test('--diff-base selects renamed files under the new path', () => {
  const root = gitProject();
  try {
    writeFileSync(path.join(root, 'src', 'old.js'), 'function alpha() {\n  return 1;\n}\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    git(root, 'mv', 'src/old.js', 'src/new.js');
    writeFileSync(path.join(root, 'src', 'new.js'), 'function alpha() {\n  return 100;\n}\n');
    const r = runCli(root, ['--diff-base', 'HEAD']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /alpha\s+src\/new\.js/);
    assert.doesNotMatch(r.stdout, /src\/old\.js/);
  } finally {
    cleanup(root);
  }
});

test('--diff-base with explicit paths scopes the diff to those paths', () => {
  const root = gitProject();
  try {
    writeFileSync(path.join(root, 'src', 'a.js'), 'function fnA() {\n  return 1;\n}\n');
    writeFileSync(path.join(root, 'src', 'b.js'), 'function fnB() {\n  return 2;\n}\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    writeFileSync(path.join(root, 'src', 'a.js'), 'function fnA() {\n  return 11;\n}\n');
    writeFileSync(path.join(root, 'src', 'b.js'), 'function fnB() {\n  return 22;\n}\n');
    const r = runCli(root, ['--diff-base', 'HEAD', 'src/a.js']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /fnA/);
    assert.doesNotMatch(r.stdout, /fnB/);
  } finally {
    cleanup(root);
  }
});

test('--diff-base run that touches no function reports the empty selection and exits 0', () => {
  const root = gitProject();
  try {
    const src = path.join(root, 'src', 'tail.js');
    writeFileSync(src, 'function stay() {\n  return 1;\n}\nconst tail = 4;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    writeFileSync(src, 'function stay() {\n  return 1;\n}\nconst tail = 5;\n');
    const r = runCli(root, ['--diff-base', 'HEAD']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /No JavaScript files to analyze\./);
  } finally {
    cleanup(root);
  }
});

test('--diff-base with an unknown ref exits 1', () => {
  const root = gitProject();
  try {
    writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    const r = runCli(root, ['--diff-base', 'no-such-ref']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /git diff no-such-ref failed/);
  } finally {
    cleanup(root);
  }
});

test('--diff-base combined with --changed exits 1', () => {
  const r = runCli(process.cwd(), ['--diff-base', 'HEAD', '--changed']);
  assert.equal(r.status, 1);
});

// --- --strict extras (issue #79; the coverage-input gate itself is now default) ---

// Builds a project with optional coverage content; shared by the fail-closed
// default tests above and the --strict extras below.

function strictProject({ coverageContent, coverageName = 'coverage-final.json' }) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-strict-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'coverage'));
  cpSync(path.join(FIXTURES, 'sample.js'), path.join(root, 'src', 'sample.js'));
  if (coverageContent !== undefined) {
    writeFileSync(path.join(root, 'coverage', coverageName), coverageContent);
  }
  return root;
}

test('--strict exits 1 when the coverage file is missing', () => {
  const root = strictProject({});
  try {
    const r = runCli(root, ['--strict']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /coverage file not found/);
  } finally {
    cleanup(root);
  }
});

test('--strict exits 1 on an lcov file with zero records', () => {
  const root = strictProject({ coverageContent: 'TN:\n', coverageName: 'lcov.info' });
  try {
    const r = runCli(root, ['--strict', '--coverage', 'coverage/lcov.info']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no records/);
  } finally {
    cleanup(root);
  }
});

test('--strict exits 1 on a coverage parse failure', () => {
  const root = strictProject({
    coverageContent: 'TN:\nSF:src/sample.js\nDA:oops\nend_of_record\n',
    coverageName: 'lcov.info',
  });
  try {
    const r = runCli(root, ['--strict', '--coverage', 'coverage/lcov.info']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /failed to parse coverage file/);
  } finally {
    cleanup(root);
  }
});

test('--strict exits 1 on an explicit path that does not exist', () => {
  const root = strictProject({});
  try {
    const r = runCli(root, ['--strict', 'src/nope.js']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /path does not exist: src\/nope\.js/);
  } finally {
    cleanup(root);
  }
});

test('--strict scores a selected file with no coverage entry as 0.0% covered', () => {
  const root = strictProject({});
  try {
    // b.js has no coverage entry; a.js's entry covers addPositive fully.
    writeFileSync(path.join(root, 'src', 'b.js'), 'function tiny(a) {\n  return a;\n}\n');
    const src = path.join(root, 'src', 'sample.js');
    const statementMap = {
      '0': { start: { line: 5, column: 0 }, end: { line: 5, column: 0 } },
      '1': { start: { line: 6, column: 0 }, end: { line: 6, column: 0 } },
    };
    writeFileSync(
      path.join(root, 'coverage', 'coverage-final.json'),
      JSON.stringify({ [src]: { statementMap, s: { '0': 1, '1': 1 } } }),
    );
    const r = runCli(root, ['--strict']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // tiny: CC=1, coverage=0 -> CRAP 2.0 as a computed row (not N/A).
    assert.match(r.stdout, /tiny\s+src\/b\.js\s+1\s+0\.0%\s+2\.0/);
    assert.match(r.stdout, /addPositive\s+src\/sample\.js\s+2\s+100\.0%\s+2\.0/);
  } finally {
    cleanup(root);
  }
});

test('--strict keeps N/A for statement-less functions in files with coverage entries', () => {
  const root = strictProject({});
  try {
    const src = path.join(root, 'src', 'sample.js');
    writeFileSync(
      src,
      'function real() {\n  return 1;\n}\nfunction hollow() {}\n',
    );
    writeFileSync(
      path.join(root, 'coverage', 'coverage-final.json'),
      JSON.stringify({
        [src]: {
          statementMap: { '0': { start: { line: 2, column: 0 }, end: { line: 2, column: 0 } } },
          s: { '0': 1 },
        },
      }),
    );
    const r = runCli(root, ['--strict']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /real\s+src\/sample\.js\s+1\s+100\.0%\s+1\.0/);
    assert.match(r.stdout, /hollow\s+src\/sample\.js\s+1\s+N\/A\s+N\/A/);
  } finally {
    cleanup(root);
  }
});

// --- --exclude (issue #79) ---

test('--exclude drops files matching the project-relative glob (repeatable)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-exclude-'));
  try {
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'coverage'));
    const src = path.join(root, 'src', 'sample.js');
    const high = path.join(root, 'src', 'high_crap.js');
    cpSync(path.join(FIXTURES, 'sample.js'), src);
    cpSync(path.join(FIXTURES, 'high_crap.js'), high);
    writeFileSync(
      path.join(root, 'coverage', 'coverage-final.json'),
      JSON.stringify({
        [src]: {
          statementMap: { '0': { start: { line: 5, column: 0 }, end: { line: 6, column: 0 } } },
          s: { '0': 1 },
        },
        [high]: {
          statementMap: { '0': { start: { line: 9, column: 0 }, end: { line: 14, column: 0 } } },
          s: { '0': 0 },
        },
      }),
    );
    const excluded = runCli(root, ['--exclude', 'src/high*']);
    assert.equal(excluded.status, 0, `stderr: ${excluded.stderr}`);
    assert.match(excluded.stdout, /addPositive/);
    assert.doesNotMatch(excluded.stdout, /deepNested/);
    const both = runCli(root, ['--exclude', 'src/high_crap.js', '--exclude', 'src/sample.js']);
    assert.equal(both.status, 0, `stderr: ${both.stderr}`);
    assert.match(both.stdout, /No JavaScript files to analyze\./);
  } finally {
    cleanup(root);
  }
});
