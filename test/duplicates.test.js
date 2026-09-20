import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  duplicatesViolations,
  parseDuplicateArgs,
  runDuplicates,
} from '../src/duplicates.js';
import { tokenizeSource } from '../src/complexity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A fixture root; files are written at project-relative paths (parent
// directories created as needed).
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-duplicates-'));
  for (const [rel, source] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function fakeCtx(cwd) {
  const out = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    lines: out,
  };
}

// Nine tokens per line: name [ i ] = y + i ;
function blockLines(n, name = 'x') {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`${name}[${i}] = y + ${i};`);
  return lines;
}

const SMALL = { threshold: 1, minTokens: 5, minLines: 2 };

// Upstream windows straddle statement boundaries: every JS statement ends
// in `;`, so a repeated block drags the preceding line's final `;` into
// the duplicated set (same as upstream's Rabin-Karp over all windows).
// Fixtures therefore pin whole-percentage expectations verified against
// the algorithm rather than naive "only the block lines" sets.

test('within-file duplicate: flagged with percent, first line, upstream message', () => {
  // The 3-line block twice plus two unique tail lines: 6 of 8 lines are
  // duplicated (the statement boundary before each block participates).
  const source = [...blockLines(3), ...blockLines(3), 'const alpha = 1;', 'const beta = 2;'];
  const root = fixture({ 'src/a.js': source.join('\n') + '\n' });
  try {
    const { violations, checked } = duplicatesViolations(
      [path.join(root, 'src/a.js')],
      root,
      SMALL,
    );
    assert.equal(checked, 1);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'src/a.js');
    assert.equal(violations[0].line, 1);
    assert.equal(violations[0].message, '75.00% duplicated lines > 1%');
  } finally {
    cleanup(root);
  }
});

test('cross-file duplicate: both files flagged, default threshold trips', () => {
  const source = ['const header = 1;', ...blockLines(3)].join('\n') + '\n';
  const root = fixture({ 'src/a.js': source, 'src/b.js': source });
  try {
    const ctx = fakeCtx(root);
    const code = runDuplicates(["--min-tokens", "5", "--min-lines", "2"], ctx);
    assert.equal(code, 2);
    assert.equal(ctx.lines.length, 3);
    assert.equal(ctx.lines[0], 'src/a.js:1: 100.00% duplicated lines > 1%\n');
    assert.equal(ctx.lines[1], 'src/b.js:1: 100.00% duplicated lines > 1%\n');
    assert.equal(ctx.lines[2], '2/2 files over 1% duplication\n');
  } finally {
    cleanup(root);
  }
});

// Numeric flag round-trip (CLI-reported concern): every number flag must
// reach the detector. The fixture is a real-sized pair — two files sharing
// an identical 63-token 7-line block (9 tokens per line). Upstream
// semantics, pinned here deliberately: a window is recorded only when it
// spans at least `min_lines` lines (upstream `_recordIfValid`), so a
// SMALLER `--min-tokens` alone can legitimately stop detecting — its
// windows no longer span the default 5 lines. That is not lost wiring;
// lowering `--min-lines` alongside restores detection.
test('numeric flags round-trip through the CLI to the detector', () => {
  const code = blockLines(7).join('\n') + '\n';
  const root = fixture({ 'src/a.js': code, 'other/b.js': code });
  try {
    const run = (args) => {
      const ctx = fakeCtx(root);
      return [runDuplicates(['src', 'other', ...args], ctx), ctx.lines.join('')];
    };
    // Default flags: 50-token windows span all 7 lines — both flagged.
    assert.deepEqual(run([]), [2, ['other/b.js:1: 100.00% duplicated lines > 1%', 'src/a.js:1: 100.00% duplicated lines > 1%', '2/2 files over 1% duplication'].join('\n') + '\n']);
    // The reported repro: min-tokens 20 alone — windows span < 5 lines,
    // so no window is recorded and the pair scans clean (upstream-faithful).
    assert.deepEqual(run(['--min-tokens', '20']), [0, '2 files, 0.00% duplicated lines\n']);
    // min-tokens below default DOES detect when windows still span
    // min-lines — the flag provably reaches the window indexing.
    assert.deepEqual(run(['--min-tokens', '20', '--min-lines', '2'])[0], 2);
    // Whole-file windows (63 tokens = the entire block): still detected.
    assert.deepEqual(run(['--min-tokens', '63'])[0], 2);
    // min-lines alone round-trips: relaxed span, default window size.
    assert.deepEqual(run(['--min-lines', '2'])[0], 2);
    // threshold round-trips into both the comparison and the message.
    const [overCode, overOut] = run(['--threshold', '0.5']);
    assert.equal(overCode, 2);
    assert.match(overOut, /2\/2 files over 0\.5% duplication/);
    assert.deepEqual(run(['--threshold', '100'])[0], 0);
  } finally {
    cleanup(root);
  }
});

test('min-tokens boundary: exactly minTokens detected, one more not', () => {
  // Block: `x[0] = y;` (7 tokens) + `z = 0` (3 tokens) = exactly 10 tokens
  // spanning 2 lines, repeated once.
  const block = ['x[0] = y;', 'z = 0'];
  const root = fixture({ 'src/a.js': [...block, ...block].join('\n') + '\n' });
  try {
    const file = [path.join(root, 'src/a.js')];
    const at = duplicatesViolations(file, root, { threshold: 1, minTokens: 10, minLines: 2 });
    assert.equal(at.violations.length, 1);
    assert.equal(at.violations[0].message, '100.00% duplicated lines > 1%');
    const beyond = duplicatesViolations(file, root, { threshold: 1, minTokens: 11, minLines: 2 });
    assert.deepEqual(beyond.violations, []);
  } finally {
    cleanup(root);
  }
});

test('min-lines boundary: exactly minLines detected, one more not', () => {
  // Block: three 2-token lines (`q0;` …) = 6 tokens spanning 3 lines.
  const block = ['q0;', 'q1;', 'q2;'];
  const source =
    ['const header = 1;', ...block, 'const tail = 2;', ...block].join('\n') +
    '\n';
  const root = fixture({ 'src/a.js': source });
  try {
    const file = [path.join(root, 'src/a.js')];
    const at = duplicatesViolations(file, root, { threshold: 1, minTokens: 5, minLines: 3 });
    assert.equal(at.violations.length, 1);
    const beyond = duplicatesViolations(file, root, { threshold: 1, minTokens: 5, minLines: 4 });
    assert.deepEqual(beyond.violations, []);
  } finally {
    cleanup(root);
  }
});

test('threshold boundary: percent == threshold passes, above fails', () => {
  // The twice-repeated block plus two unique lines: exactly 75% duplicated.
  const source = [...blockLines(3), ...blockLines(3), 'const alpha = 1;', 'const beta = 2;'];
  const root = fixture({ 'src/a.js': source.join('\n') + '\n' });
  try {
    const file = [path.join(root, 'src/a.js')];
    const equal = duplicatesViolations(file, root, { threshold: 75, minTokens: 5, minLines: 2 });
    assert.deepEqual(equal.violations, []);
    const over = duplicatesViolations(file, root, { threshold: 74, minTokens: 5, minLines: 2 });
    assert.equal(over.violations[0].message, '75.00% duplicated lines > 74%');
  } finally {
    cleanup(root);
  }
});

test('--source unions extra paths: cross-module pair detected, missing skipped', () => {
  const source = ['const header = 1;', ...blockLines(3)].join('\n') + '\n';
  const root = fixture({
    'src/main.js': source,
    'vendor/module/peer.js': source,
  });
  try {
    const alone = fakeCtx(root);
    assert.equal(runDuplicates(["--min-tokens", "5", "--min-lines", "2"], alone), 0);
    assert.equal(alone.lines[0], '1 files, 0.00% duplicated lines\n');

    const unioned = fakeCtx(root);
    assert.equal(runDuplicates(['--min-tokens', '5', '--min-lines', '2', '--source', 'vendor/module'], unioned), 2);
    assert.equal(unioned.lines[0], 'src/main.js:1: 100.00% duplicated lines > 1%\n');
    assert.equal(unioned.lines[1], 'vendor/module/peer.js:1: 100.00% duplicated lines > 1%\n');
    assert.equal(unioned.lines[2], '2/2 files over 1% duplication\n');

    const missing = fakeCtx(root);
    assert.equal(runDuplicates(['--min-tokens', '5', '--min-lines', '2', '--source', 'does-not-exist'], missing), 0);
    assert.equal(missing.lines[0], '1 files, 0.00% duplicated lines\n');
  } finally {
    cleanup(root);
  }
});
test('--exclude glob drops matching project-relative paths', () => {
  // a.js duplicates itself, so excluding its partner b.js still leaves one
  // flagged file; b.js alone would go quiet once a partner is excluded.
  const shared = ['const header = 1;', ...blockLines(3)].join('\n') + '\n';
  const aSource = [...blockLines(3), ...blockLines(3)].join('\n') + '\n';
  const root = fixture({ 'src/a.js': aSource, 'src/b.js': shared });
  try {
    const excluded = fakeCtx(root);
    assert.equal(runDuplicates(['--min-tokens', '5', '--min-lines', '2', '--exclude', 'src/b.js'], excluded), 2);
    assert.equal(excluded.lines.length, 2);
    assert.equal(excluded.lines[0], 'src/a.js:1: 100.00% duplicated lines > 1%\n');
    assert.equal(excluded.lines[1], '1/1 files over 1% duplication\n');

    const all = fakeCtx(root);
    assert.equal(runDuplicates(['--min-tokens', '5', '--min-lines', '2', '--exclude', '**/*.js'], all), 0);
    assert.equal(all.lines[0], 'No source files to check.\n');
  } finally {
    cleanup(root);
  }
});

test('test files and test directories are excluded by default', () => {
  const source = ['const header = 1;', ...blockLines(3)].join('\n') + '\n';
  const root = fixture({
    'src/a.js': source,
    'src/a.test.js': source,
    'test/helpers.js': source,
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runDuplicates(["--min-tokens", "5", "--min-lines", "2"], ctx), 0);
    assert.equal(ctx.lines[0], '1 files, 0.00% duplicated lines\n');
    assert.ok(!ctx.lines.join('').includes('.test.js'));
    assert.ok(!ctx.lines.join('').includes('helpers.js'));
  } finally {
    cleanup(root);
  }
});

test('files with fewer than minTokens tokens are skipped from the scan', () => {
  const root = fixture({ 'src/tiny.js': 'a = 1;\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runDuplicates(['--min-tokens', '5'], ctx), 0);
    assert.equal(ctx.lines[0], '0 files, 0.00% duplicated lines\n');
    const { checked } = duplicatesViolations(
      [path.join(root, 'src/tiny.js')],
      root,
      SMALL,
    );
    assert.equal(checked, 0);
  } finally {
    cleanup(root);
  }
});

test('comments are not tokens: blocks differing only in comments duplicate', () => {
  const commented = blockLines(3).map((l) => `${l} // note ${l}`).join('\n');
  const source = (body) => `const header = 1;\n${body}\n`;
  const root = fixture({
    'src/a.js': source(commented),
    'src/b.js': source(blockLines(3).join('\n')),
  });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runDuplicates(["--min-tokens", "5", "--min-lines", "2"], ctx), 2);
    assert.equal(ctx.lines[0], 'src/a.js:1: 100.00% duplicated lines > 1%\n');
    assert.equal(ctx.lines[2], '2/2 files over 1% duplication\n');
  } finally {
    cleanup(root);
  }
});

test('parseDuplicateArgs: defaults, repeatable flags, inline values, paths', () => {
  assert.deepEqual(parseDuplicateArgs([]), {
    threshold: 1,
    minTokens: 50,
    minLines: 5,
    exclude: [],
    source: [],
    paths: [],
  });
  assert.deepEqual(
    parseDuplicateArgs([
      '--threshold', '2.5',
      '--min-tokens=10',
      '--min-lines', '3',
      '--exclude', 'gen/**',
      '--exclude=vendor/**',
      '--source', 'lib',
      '--source=peer',
      'src/custom.js',
    ]),
    {
      threshold: 2.5,
      minTokens: 10,
      minLines: 3,
      exclude: ['gen/**', 'vendor/**'],
      source: ['lib', 'peer'],
      paths: ['src/custom.js'],
    },
  );
});

test('parseDuplicateArgs: usage errors throw', () => {
  assert.throws(() => parseDuplicateArgs(['--threshold']), /--threshold requires a value/);
  assert.throws(() => parseDuplicateArgs(['--threshold=abc']), /Invalid --threshold: abc/);
  assert.throws(() => parseDuplicateArgs(['--min-tokens=-1']), /Invalid --min-tokens: -1/);
  assert.throws(() => parseDuplicateArgs(['--bogus=1']), /unknown flag: --bogus/);
});

test('tokenizeSource: lexemes and lines, comments and EOF skipped, TS routed', () => {
  const tokens = tokenizeSource('const a = 1; // note\n', '.js');
  assert.deepEqual(
    tokens.map((t) => t.value),
    ['const', 'a', '=', '1', ';'],
  );
  assert.deepEqual(tokens.map((t) => t.line), [1, 1, 1, 1, 1]);
  const ts = tokenizeSource('const x: number = 1;\nlet y = 2;\n', '.ts');
  assert.deepEqual(
    ts.map((t) => t.value),
    ['const', 'x', ':', 'number', '=', '1', ';', 'let', 'y', '=', '2', ';'],
  );
  assert.deepEqual(ts.map((t) => t.line), [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
});
