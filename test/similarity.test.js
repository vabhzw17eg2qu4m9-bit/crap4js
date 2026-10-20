import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  SHINGLE_SIZE,
  analyzeSimilarity,
  containment,
  jaccard,
  metricsFor,
  normalizeCode,
  normalizeMarkdown,
  parseSimilarityArgs,
  profileFor,
  runSimilarity,
  shinglesFor,
  tokensFor,
} from '../src/similarity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

// Shared prose fixtures (ported from upstream test/similarity/similarity_fixtures.dart).
// PROSE_A is the 26 nato words plus their first 16 repeated: 42 prose
// tokens, 35 8-token windows of which 9 repeat — 26 unique shingles
// (pinned by the measurement test below, well over the 10-shingle floor
// the cluster tests use).
const PROSE_A =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet ' +
  'kilo lima mike november oscar papa quebec romeo sierra tango uniform ' +
  'victor whiskey xray yankee zulu alpha bravo charlie delta echo ' +
  'foxtrot golf hotel india juliet kilo lima mike november oscar papa';

// Near-duplicate of PROSE_A: one word differs after lowercasing.
const PROSE_B =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet ' +
  'kilo lima mike november oscar papa quebec SIERRA tango uniform ' +
  'victor whiskey xray yankee zulu alpha bravo charlie delta echo ' +
  'foxtrot golf hotel india juliet kilo lima mike november delta papa';

// Unrelated prose sharing no 8-token window with PROSE_A (36 tokens).
const PROSE_C =
  'the quick brown fox jumps over the lazy dog while the sleepy cat ' +
  'naps under the warm sun dreaming about fish and mice and cream ' +
  'the dog barks loudly at nothing in particular every single night';

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-similarity-'));
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
  return { cwd, out: { write: (s) => out.push(s) }, lines: out };
}

// The cluster-test defaults (upstream: jaccard 0.5 / containment 0.85 /
// min-shingles 10 over the shared fixtures).
function analyze(root, overrides = {}) {
  return analyzeSimilarity(root, {
    dirs: ['.'],
    include: ['**/*.md'],
    exclude: [],
    jaccard: 0.5,
    containment: 0.85,
    minShingles: 10,
    ...overrides,
  });
}

test('fixture measurement: tokens and shingles clear the test floor', () => {
  // The cluster tests use min-shingles 10; the fixtures must really be
  // above it or every expectation below would be vacuous.
  const tokens = tokensFor(PROSE_A, 'markdown');
  assert.equal(tokens.length, 42);
  const shingles = shinglesFor(PROSE_A, 'markdown');
  assert.equal(shingles.size, 26); // 35 windows, 9 repeat in the tail
  assert.ok(shingles.size >= 10);
  assert.ok(tokensFor(PROSE_C, 'markdown').length >= SHINGLE_SIZE);
});

test('profileFor maps extensions to profiles', () => {
  assert.equal(profileFor('docs/a.md'), 'markdown');
  assert.equal(profileFor('docs/a.MDX'), 'markdown');
  assert.equal(profileFor('src/a.js'), 'code');
  assert.equal(profileFor('lib/a.java'), 'code');
  assert.equal(profileFor('data.csv'), 'raw');
  assert.equal(profileFor('noext'), 'raw');
});

test('markdown normalization drops fenced code blocks', () => {
  const normalized = normalizeMarkdown(
    '# Title\n\nProse line one.\n```dart\nfinal hidden = 1;\n```\nProse line two.\n',
  );
  assert.match(normalized, /Prose line one\./);
  assert.doesNotMatch(normalized, /hidden/);
});

test('markdown normalization toggles on tildes too', () => {
  const normalized = normalizeMarkdown('keep ~~this~~\n~~~\ndropped words\n~~~\nmore prose\n');
  assert.match(normalized, /keep/);
  assert.doesNotMatch(normalized, /dropped/);
  assert.match(normalized, /more prose/);
});

test('code normalization strips comments and import-family lines', () => {
  const normalized = normalizeCode(
    'import "package:x/x.dart";\n' +
      'library foo;\n' +
      '// a line comment\n' +
      'void main() {\n' +
      '  /* block */ final a = 1;\n' +
      '}\n',
  );
  assert.doesNotMatch(normalized, /import|library|comment/);
  assert.match(normalized, /final a = 1;/);
});

test('code normalization rejoins after a closed multi-line comment', () => {
  const normalized = normalizeCode('/* one\ntwo */ final kept = true;\n');
  assert.match(normalized, /final kept = true;/);
  assert.doesNotMatch(normalized, /one/);
});

test('code tokens map literals to placeholders and lowercase identifiers', () => {
  const tokens = tokensFor(
    'final width = 640;\nfinal name = "abc";\n',
    'code',
  );
  assert.deepEqual(tokens, ['final', 'width', 'N', 'final', 'name', 'S']);
  assert.ok(!tokens.includes('640'));
});

test('prose tokens are lowercased words of 2+ chars', () => {
  assert.deepEqual(tokensFor('The Quick brown fox A x1', 'markdown'), [
    'the',
    'quick',
    'brown',
    'fox',
    'x1',
  ]);
});

test('files shorter than one shingle yield an empty set', () => {
  assert.equal(shinglesFor('too short', 'raw').size, 0);
});

test('9 tokens yield exactly 2 shingles', () => {
  const content = 'one two three four five six seven eight nine';
  const a = shinglesFor(content, 'raw');
  const b = shinglesFor(content, 'raw');
  assert.deepEqual([...a], [...b]);
  assert.equal(a.size, 2);
});

test('jaccard is intersection over union', () => {
  const a = new Set(['x', 'y', 'z']);
  const b = new Set(['x', 'y', 'q']);
  assert.ok(Math.abs(jaccard(a, b) - 2 / 4) < 1e-9);
  assert.equal(jaccard(a, new Set(a)), 1.0);
  assert.equal(jaccard(a, new Set()), 0.0);
});

test('containment is intersection over the smaller set', () => {
  const a = new Set(['x', 'y', 'z']);
  const b = new Set(['x', 'y', 'q']);
  const big = new Set(['x', 'y', 'z', 'q', 'r', 's']);
  assert.equal(containment(big, a), 1.0);
  assert.ok(Math.abs(containment(a, b) - 2 / 3) < 1e-9);
  assert.equal(containment(a, new Set()), 0.0);
});

test('exact duplicates cluster with jaccard 1.0', () => {
  const root = fixture({ 'a.md': PROSE_A, 'b.md': PROSE_A });
  try {
    const report = analyze(root);
    assert.equal(report.scanned, 2);
    assert.equal(report.clusters.length, 1);
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0].jaccard, 1.0);
    assert.ok(report.pairs[0].containment > 0.99);
    assert.ok(!report.clean);
  } finally {
    cleanup(root);
  }
});

test('near-duplicates cross the threshold, unrelated files do not', () => {
  const root = fixture({ 'a.md': PROSE_A, 'b.md': PROSE_B, 'c.md': PROSE_C });
  try {
    const report = analyze(root);
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0].a, 'a.md');
    assert.equal(report.pairs[0].b, 'b.md');
    // One changed word (post-lowercasing) keeps almost all 8-token
    // windows shared: well above the 0.5 threshold, while the unrelated
    // PROSE_C stays near 0.
    assert.ok(report.pairs[0].jaccard > 0.4);
  } finally {
    cleanup(root);
  }
});

// KILLING TEST: cluster-per-pair (union-find transitivity broken) makes
// three identical files three 2-file clusters instead of one 3-file one.
test('transitive pairs merge into one cluster', () => {
  const root = fixture({
    'a.md': PROSE_A,
    'b.md': PROSE_A,
    'c.md': PROSE_A,
  });
  try {
    const report = analyze(root);
    assert.equal(report.clusters.length, 1);
    assert.deepEqual(report.clusters[0].files, ['a.md', 'b.md', 'c.md']);
    assert.equal(report.clusters[0].pairs.length, 3);
  } finally {
    cleanup(root);
  }
});

// KILLING TEST: swapping the acceptance metrics (jaccard vs containment)
// drops this pair entirely — jaccard is far below its 0.9 threshold.
test('containment catches a small file copied into a big one', () => {
  const root = fixture({
    'small.md': PROSE_A,
    'big.md': `${PROSE_A}\n\n${PROSE_C}\n\n${PROSE_B}`,
  });
  try {
    const report = analyze(root, { jaccard: 0.9, containment: 0.85 });
    assert.equal(report.pairs.length, 1);
    assert.ok(report.pairs[0].containment > 0.85);
    assert.ok(report.pairs[0].jaccard < 0.9);
  } finally {
    cleanup(root);
  }
});

// KILLING TEST: removing any part of the code normalization (import
// stripping, literal placeholders, identifier lowercasing, comment
// stripping) breaks the exact-shingle equality this pins.
test('code files differing only in noise normalize to identical shingles', () => {
  const root = fixture({
    'a.js':
      'import x from "one";\n' +
      '// setup note\n' +
      'const Width = 640;\n' +
      'function render(value) { return value + Width; }\n',
    'b.js':
      'import y from "two";\n' +
      '/* different\n   note */\n' +
      'const width = 480;\n' +
      'function render(value) { return value + width; }\n',
  });
  try {
    const report = analyze(root, {
      include: ['**/*.js'],
      minShingles: 2,
    });
    assert.equal(report.scanned, 2);
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0].jaccard, 1.0);
    assert.equal(report.pairs[0].containment, 1.0);
  } finally {
    cleanup(root);
  }
});

// KILLING TEST: dropping markdown fence normalization matches the fenced
// code into the shingles — the exact 1.0 pin breaks.
test('markdown fences are excluded from the comparison', () => {
  const root = fixture({
    'a.md': `${PROSE_C}\n\`\`\`js\nconst aa = one;\n\`\`\`\n`,
    'b.md': `${PROSE_C}\n\`\`\`js\nconst bb = two;\n\`\`\`\n`,
  });
  try {
    const report = analyze(root);
    assert.equal(report.scanned, 2);
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0].jaccard, 1.0);
  } finally {
    cleanup(root);
  }
});

test('metricsFor returns the strongest pair of a file', () => {
  const root = fixture({ 'a.md': PROSE_A, 'b.md': PROSE_A, 'c.md': PROSE_C });
  try {
    const report = analyze(root);
    assert.equal(metricsFor(report, 'a.md').jaccard, 1.0);
    assert.equal(metricsFor(report, 'c.md'), null);
  } finally {
    cleanup(root);
  }
});

test('files below the shingle floor are skipped', () => {
  const root = fixture({
    'tiny.md': 'too short',
    'a.md': PROSE_A,
    'c.md': PROSE_C,
  });
  try {
    const report = analyze(root, { minShingles: 20 });
    assert.equal(report.scanned, 2);
    assert.equal(report.skipped, 1);
  } finally {
    cleanup(root);
  }
});

test('exclude globs drop files from the scan', () => {
  const root = fixture({
    'a.md': PROSE_A,
    'generated/b.md': PROSE_A,
  });
  try {
    const report = analyze(root, { exclude: ['generated/**'] });
    assert.equal(report.scanned, 1);
    assert.ok(report.clean);
    assert.equal(report.clusters.length, 0);
  } finally {
    cleanup(root);
  }
});

test('include globs limit the scan to matching files', () => {
  const root = fixture({ 'a.md': PROSE_A, 'a.txt': PROSE_A });
  try {
    const report = analyze(root, { include: ['*.txt'] });
    assert.equal(report.scanned, 1);
  } finally {
    cleanup(root);
  }
});

test('dirs limit the scan roots', () => {
  const root = fixture({
    'docs/a.md': PROSE_A,
    'other/b.md': PROSE_A,
  });
  try {
    const report = analyze(root, { dirs: ['other'] });
    assert.equal(report.scanned, 1);
    assert.ok(report.clean);
  } finally {
    cleanup(root);
  }
});

test('clean corpora report clean', () => {
  const root = fixture({ 'a.md': PROSE_A, 'c.md': PROSE_C });
  try {
    const report = analyze(root);
    assert.ok(report.clean);
    assert.equal(report.clusters.length, 0);
  } finally {
    cleanup(root);
  }
});

test('parseSimilarityArgs defaults mirror the upstream template', () => {
  const opts = parseSimilarityArgs([]);
  assert.equal(opts.format, 'console');
  assert.equal(opts.jaccard, 0.8);
  assert.equal(opts.containment, 0.95);
  assert.equal(opts.minShingles, 50);
  assert.deepEqual(opts.include, []);
  assert.deepEqual(opts.exclude, []);
  assert.deepEqual(opts.paths, []);
});

test('parseSimilarityArgs accepts =, repeatable globs and validates', () => {
  const opts = parseSimilarityArgs([
    '--format=json',
    '--jaccard', '0.6',
    '--containment=0.9',
    '--min-shingles', '30',
    '--include', 'docs/**',
    '--include=lib/**/*.md',
    '--exclude', 'generated/**',
    'docs',
  ]);
  assert.equal(opts.format, 'json');
  assert.equal(opts.jaccard, 0.6);
  assert.equal(opts.containment, 0.9);
  assert.equal(opts.minShingles, 30);
  assert.deepEqual(opts.include, ['docs/**', 'lib/**/*.md']);
  assert.deepEqual(opts.exclude, ['generated/**']);
  assert.deepEqual(opts.paths, ['docs']);

  assert.throws(() => parseSimilarityArgs(['--format', 'yaml']), /Invalid --format/);
  assert.throws(() => parseSimilarityArgs(['--jaccard', '1.5']), /Invalid --jaccard/);
  assert.throws(() => parseSimilarityArgs(['--containment', '-1']), /Invalid --containment/);
  assert.throws(() => parseSimilarityArgs(['--min-shingles', '2.5']), /Invalid --min-shingles/);
  assert.throws(() => parseSimilarityArgs(['--min-shingles', 'abc']), /Invalid --min-shingles/);
});

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('cli: console report prints clusters and stays informational', () => {
  const root = fixture({
    'a.md': PROSE_A,
    'b.md': PROSE_A,
    'c.md': PROSE_C,
  });
  try {
    const r = runCli(root, [
      'similarity',
      '--jaccard', '0.5',
      '--min-shingles', '10',
      '--containment', '0.85',
    ]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /cluster 1 — 2 files:/);
    assert.match(r.stdout, /a\.md/);
    assert.match(r.stdout, /b\.md/);
    assert.match(r.stdout, /jaccard 1\.00/);
    assert.match(r.stdout, /2 files in 1 clusters/);
    assert.match(r.stdout, /similarity: 3 files scanned/);
  } finally {
    cleanup(root);
  }
});

test('cli: clean corpus prints no similar files, exit 0', () => {
  const root = fixture({ 'a.md': PROSE_A, 'c.md': PROSE_C });
  try {
    const r = runCli(root, ['similarity', '--jaccard', '0.5', '--min-shingles', '10']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no similar files/);
  } finally {
    cleanup(root);
  }
});

test('cli: explicit directory argument becomes the scan root', () => {
  const root = fixture({ 'docs/a.md': PROSE_A, 'docs/b.md': PROSE_A, 'x.md': PROSE_A });
  try {
    const r = runCli(root, ['similarity', 'docs', '--jaccard', '0.5', '--min-shingles', '10']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /2 files scanned/);
    assert.match(r.stdout, /a\.md/);
    assert.doesNotMatch(r.stdout, /x\.md/);
  } finally {
    cleanup(root);
  }
});

test('cli: several positional paths scan as subdirectories of the root', () => {
  const root = fixture({ 'docs/a.md': PROSE_A, 'other/b.md': PROSE_A });
  try {
    const r = runCli(root, ['similarity', 'docs', 'other', '--min-shingles', '10']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /2 files scanned/);
    assert.match(r.stdout, /cluster 1 — 2 files:/);
  } finally {
    cleanup(root);
  }
});

test('cli: json output is valid JSON with the report shape', () => {
  const root = fixture({ 'a.md': PROSE_A, 'b.md': PROSE_A });
  try {
    const r = runCli(root, [
      'similarity',
      '--format', 'json',
      '--jaccard', '0.5',
      '--min-shingles', '10',
    ]);
    assert.equal(r.status, 0);
    const decoded = JSON.parse(r.stdout);
    assert.equal(decoded.scanned, 2);
    assert.equal(decoded.skipped, 0);
    assert.equal(decoded.pairs.length, 1);
    assert.equal(decoded.pairs[0].jaccard, 1.0);
    assert.deepEqual(decoded.clusters[0].files, ['a.md', 'b.md']);
    assert.equal(decoded.thresholds.jaccard, 0.5);
    assert.equal(decoded.thresholds.min_shingles, 10);
  } finally {
    cleanup(root);
  }
});

test('cli: invalid flags are usage errors (exit 1)', () => {
  const root = fixture({ 'a.md': PROSE_A });
  try {
    assert.equal(runCli(root, ['similarity', '--format', 'yaml']).status, 1);
    assert.equal(runCli(root, ['similarity', '--jaccard', '3']).status, 1);
  } finally {
    cleanup(root);
  }
});

test('runSimilarity always exits 0, clean or dirty', () => {
  const dirty = fixture({ 'a.md': PROSE_A, 'b.md': PROSE_A });
  const clean = fixture({ 'a.md': PROSE_A, 'c.md': PROSE_C });
  try {
    assert.equal(runSimilarity(['--min-shingles', '10'], fakeCtx(dirty)), 0);
    assert.equal(runSimilarity(['--min-shingles', '10'], fakeCtx(clean)), 0);
  } finally {
    cleanup(dirty);
    cleanup(clean);
  }
});
