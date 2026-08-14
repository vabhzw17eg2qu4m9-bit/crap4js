import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  namingFiles,
  namingSummary,
  namingViolations,
  runFileNaming,
} from '../src/fileNaming.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fakeCtx(cwd) {
  const out = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    lines: out,
  };
}

function violationsFor(names) {
  const files = names.map((n) => path.join('/proj', 'src', n));
  return namingViolations(files, '/proj');
}

test('generic stem (utils, helpers, misc) is flagged', () => {
  const { violations, checked } = violationsFor(['utils.js', 'helpers.js', 'misc.ts']);
  assert.equal(checked, 3);
  assert.equal(violations.length, 3);
  assert.match(violations[0].message, /generic name "utils\.js"/);
  assert.match(violations[0].message, /split by domain/);
  assert.equal(violations[0].file, 'src/utils.js');
});

test('numeric suffix is flagged (batch1, report2, day_1)', () => {
  const { violations } = violationsFor(['batch1.js', 'report2.jsx', 'day_1.mjs']);
  assert.equal(violations.length, 3);
  assert.match(violations[0].message, /numeric suffix in "batch1\.js"/);
  assert.match(violations[0].message, /batch1, part2, v2/);
});

test('allowed stems with digits (base64, sha256, utf8) pass', () => {
  const { violations } = violationsFor(['base64.js', 'sha256.ts', 'utf8.js', 'oauth2.js']);
  assert.deepEqual(violations, []);
});

test('domain-meaningful names pass', () => {
  const { violations } = violationsFor(['invoice-parser.js', 'collab.test.js']);
  // collab.test.js is not a naming violation — test-file exclusion is a
  // separate concern (checked below via namingFiles).
  assert.deepEqual(violations, []);
});

test('namingFiles excludes test files and test directories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-naming-'));
  try {
    mkdirSync(path.join(root, 'src', 'test'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'utils.js'), 'export const a = 1;');
    writeFileSync(path.join(root, 'src', 'a.test.js'), 'export const b = 1;');
    writeFileSync(path.join(root, 'src', 'test', 'helper.js'), 'export const c = 1;');
    const files = namingFiles([], root);
    assert.deepEqual(files, [path.join(root, 'src', 'utils.js')]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('summary line counts mechanical names', () => {
  const clean = namingSummary({ violations: [], checked: 5 });
  assert.equal(clean, '5 files have domain-meaningful names');
  const dirty = namingSummary({ violations: [{}, {}], checked: 5 });
  assert.equal(dirty, '2/5 files with mechanical names');
});

test('runFileNaming prints violations + summary and exits 2', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-naming-'));
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'utils.js'), 'export const a = 1;');
    writeFileSync(path.join(root, 'src', 'invoice.js'), 'export const b = 1;');
    const ctx = fakeCtx(root);
    const code = runFileNaming([], ctx);
    assert.equal(code, 2);
    assert.equal(
      ctx.lines[0].trimEnd(),
      'src/utils.js: generic name "utils.js" — split by domain instead of accumulating unrelated declarations',
    );
    assert.equal(ctx.lines[1].trimEnd(), '1/2 files with mechanical names');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFileNaming with clean names exits 0', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-naming-'));
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'invoice.js'), 'export const b = 1;');
    const ctx = fakeCtx(root);
    assert.equal(runFileNaming([], ctx), 0);
    assert.deepEqual(ctx.lines, ['1 files have domain-meaningful names\n']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('file-naming over the repo itself finds no violations', () => {
  const ctx = fakeCtx(path.resolve(__dirname, '..'));
  assert.equal(runFileNaming([], ctx), 0);
});
