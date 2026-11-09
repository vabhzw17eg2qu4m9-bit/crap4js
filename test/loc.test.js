import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lineCount, locSummary, locViolations, parseLocArgs, runLoc } from '../src/loc.js';
import { main } from '../src/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fakeCtx(cwd) {
  const out = [];
  const err = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    lines: out,
    errors: err,
  };
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-loc-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(path.join(root, 'src', name), source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test('lineCount: empty file is 0, trailing newline opens no line', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('a'), 1);
  assert.equal(lineCount('a\n'), 1);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(lineCount('\n'), 1);
});

test('file over the limit is flagged without a line number, exit 2', () => {
  const root = fixture({ 'long.js': 'const x = 1;\nconst y = 2;\nconst z = 3;\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runLoc(['--max-lines', '2'], ctx), 2);
    assert.match(ctx.lines.join(''), /^src\/long\.js: 3 lines > max 2$/m);
    assert.match(ctx.lines.join(''), /1\/1 files over 2 lines/);
  } finally {
    cleanup(root);
  }
});

test('file exactly at the limit passes (boundary)', () => {
  const root = fixture({ 'ok.js': 'const x = 1;\nconst y = 2;\nconst z = 3;\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runLoc(['--max-lines', '3'], ctx), 0);
    assert.match(ctx.lines.join(''), /1 files within 3 lines/);
  } finally {
    cleanup(root);
  }
});

test('default limit is 800', () => {
  const root = fixture({ 'big.js': `${'x\n'.repeat(800)}y\n` });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runLoc([], ctx), 2);
    assert.match(ctx.lines.join(''), /801 lines > max 800/);
  } finally {
    cleanup(root);
  }
});

test('--exclude removes a file from the check entirely', () => {
  const root = fixture({
    'long.js': 'a\nb\nc\n',
    'short.js': 'a\n',
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runLoc(['--max-lines', '2', '--exclude', '**/long.js'], ctx), 0);
    assert.doesNotMatch(ctx.lines.join(''), /long\.js/);
    assert.match(ctx.lines.join(''), /1 files within 2 lines/);
  } finally {
    cleanup(root);
  }
});

test('--flag=VALUE form is accepted', () => {
  const root = fixture({ 'long.js': 'a\nb\nc\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runLoc(['--max-lines=2'], ctx), 2);
  } finally {
    cleanup(root);
  }
});

test('repeated --exclude globs union', () => {
  const root = fixture({
    'a.js': 'a\nb\nc\n',
    'b.js': 'a\nb\nc\n',
    'c.js': 'a\n',
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runLoc(['--max-lines', '2', '--exclude', '**/a.js', '--exclude', '**/b.js'], ctx), 0);
    assert.match(ctx.lines.join(''), /1 files within 2 lines/);
  } finally {
    cleanup(root);
  }
});

test('non-integer --max-lines is a usage error (exit 1)', () => {
  const root = fixture({ 'a.js': 'a\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(main(['loc', '--max-lines', '2.5'], ctx), 1);
    assert.match(ctx.errors.join(''), /--max-lines must be an integer/);
  } finally {
    cleanup(root);
  }
});

test('unknown flag is a usage error', () => {
  assert.throws(() => parseLocArgs(['--max=5']), /unknown flag: --max/);
});

test('locViolations counts checked files past exclusion', () => {
  const root = fixture({
    'a.js': 'a\nb\nc\n',
    'b.js': 'a\n',
  });
  try {
    const r = locViolations([path.join(root, 'src', 'a.js'), path.join(root, 'src', 'b.js')], root, {
      maxLines: 2,
    });
    assert.equal(r.checked, 2);
    assert.deepEqual(r.violations, [{ file: 'src/a.js', message: '3 lines > max 2' }]);
  } finally {
    cleanup(root);
  }
});

test('locSummary lines', () => {
  assert.equal(locSummary({ violations: 0, checked: 4 }), '4 files within 800 lines');
  assert.equal(locSummary({ violations: 2, checked: 4 }), '2/4 files over 800 lines');
  assert.equal(locSummary({ violations: 0, checked: 3 }, 100), '3 files within 100 lines');
});
