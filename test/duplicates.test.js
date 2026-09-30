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

// ---------------------------------------------------------------------------
// Type-2 clone detection (--ignore-locals / --ignore-literals), ported from
// upstream 0599df2 + 94299e0. Fixture builders mirror the upstream ones:
// each pair differs only in the dimension the test pins. Precision pairs
// run 40-token windows (every window necessarily crosses the difference);
// the raw-pass regression runs 5-token windows so interior windows of the
// shared block exist.

// Runs the duplicates CLI over two fixture files with the given flags.
function runPair(contentA, contentB, flags, minTokens = '40') {
  const root = fixture({ 'src/a.js': contentA, 'src/b.js': contentB });
  try {
    const ctx = fakeCtx(root);
    const code = runDuplicates(
      ['--min-tokens', minTokens, '--min-lines', '2', ...flags, 'src'],
      ctx,
    );
    return { code, lines: ctx.lines };
  } finally {
    cleanup(root);
  }
}

// Body whose only differences between clones are local names.
function renamedMethod(name, value, i, item, prefix, suffix, result) {
  return `
export function ${name}(${value}, ${prefix}, ${suffix}, ${result}) {
  for (let ${i} = 0; ${i} < ${value}.length; ${i}++) {
    const ${item} = ${value}[${i}];
    if (${item}.length === 0) {
      continue;
    }
    if (${item}.startsWith(${prefix})) {
      ${result}.push(${item}.substring(${prefix}.length));
    } else if (${item}.endsWith(${suffix})) {
      ${result}.push(${item}.substring(0, ${item}.length - ${suffix}.length));
    } else {
      ${result}.push(${item}.toLowerCase());
    }
  }
  return ${result};
}
`;
}
const renamedOriginal = () =>
  renamedMethod('process', 'values', 'i', 'item', 'prefix', 'suffix', 'result');
const renamedClone = () =>
  renamedMethod('handle', 'data', 'idx', 'entry', 'start', 'end', 'out');

// Body using two params in one order, and the same body with them crossed —
// a semantic swap: renaming must keep the placeholder streams different.
function swappable(name, a, b, total) {
  return `
export function ${name}(${a}, ${b}) {
  let ${total} = 0;
  for (let i = 0; i < ${a}; i++) {
    ${total} += ${b};
    if (${total} > ${a}) {
      ${total} -= 1;
    }
  }
  while (${total} < ${b}) {
    ${total} += ${a};
  }
  return ${total};
}
`;
}
function swapped(name, x, y, sum) {
  return `
export function ${name}(${x}, ${y}) {
  let ${sum} = 0;
  for (let i = 0; i < ${y}; i++) {
    ${sum} += ${x};
    if (${sum} > ${y}) {
      ${sum} -= 1;
    }
  }
  while (${sum} < ${x}) {
    ${sum} += ${y};
  }
  return ${sum};
}
`;
}

// Body whose calls differ on `method` in every branch, so no window can
// avoid the difference (API surface stays visible).
function callee(name, value, result, method) {
  return `
export function ${name}(${value}, ${result}) {
  for (let i = 0; i < ${value}.length; i++) {
    const item = ${value}[i];
    if (item.length === 0) {
      ${result}.${method}(item);
    } else if (item.startsWith('x')) {
      ${result}.${method}(item);
    } else if (item.endsWith('y')) {
      ${result}.${method}(item.toLowerCase());
    } else {
      ${result}.${method}(item.trim());
    }
  }
}
`;
}

// Class whose method reads a field; clones differ in the field name, which
// is API surface, not a local.
function repo(className, field, key, value) {
  return `
export class ${className} {
  ${field} = new Map();
  load(${key}) {
    if (this.${field}.has(${key})) {
      return this.${field}.get(${key}) ?? 0;
    }
    const ${value} = parse(${key});
    this.${field}.set(${key}, ${value});
    return ${value};
  }
}
export function parse(s) {
  return s.length;
}
`;
}

// Body whose only differences between clones are literals.
function literal(name, limit, label) {
  return `
export function ${name}(values, result) {
  const stamp = ${limit}n;
  for (let i = 0; i < values.length; i++) {
    if (values.length > ${limit}) {
      throw new RangeError('${label}');
    }
    const item = values[i];
    if (item.startsWith('${label}')) {
      result.push(item);
    } else if (item.endsWith('${label}')) {
      result.push(item.toLowerCase());
    } else {
      result.push(item.trim());
    }
  }
  return result.length;
}
`;
}

// Body exercising every renamed declaration kind: destructuring, for-of
// loop variables, a locally declared function, a catch parameter, and a
// template literal embedding a local.
function kinds(name, input, head, tail, count, piece, helper, err) {
  return `
export function ${name}(${input}) {
  try {
    const [${head}, ${tail}] = [String(${input}).length, Number(${input}) % 7];
    let ${count} = 0;
    for (const ${piece} of [${head}, ${tail}]) {
      ${count} += ${piece};
    }
    function ${helper}(size, pad = 0, ...extra) {
      const [${head}0, ...notes] = extra;
      const { length, ...fields } = size;
      return length + pad + ${head}0 + notes.length + fields.length + ${count};
    }
    return ${helper}(\`\${${count}}\`);
  } catch (${err}) {
    return ${err}.length;
  }
}
`;
}

// An exact-copy block whose enclosing scope carries extra leading locals,
// shifting placeholder numbering against plainScope (upstream 94299e0).
function shiftedScope() {
  return `
export function run(mode) {
  const noise = mode + 1;
  const warm = noise % 2 === 0 ? noise : mode;
  const log = [warm];
  const sink = [];
  for (let i = 0; i < 9; i++) {
    const entry = 7 * i;
    if (entry < 0) {
      sink.push(0);
    } else {
      sink.push(entry + 1);
    }
  }
  return [sink, log];
}
`;
}
function plainScope() {
  return `
export function walk() {
  const sink = [];
  for (let i = 0; i < 9; i++) {
    const entry = 7 * i;
    if (entry < 0) {
      sink.push(0);
    } else {
      sink.push(entry + 1);
    }
  }
  return sink;
}
`;
}

// Body whose template literals embed a local; clones rename it.
function interpolated(name, who) {
  return `
export function ${name}(users) {
  const total = users.length;
  const ${who} = 'x';
  const label = \`\${${who}}: \${total}\`;
  for (const user of users) {
    log(\`\${user} -> \${label}\`);
  }
  return label;
}
`;
}

test('ignore-locals detects renamed clone across files', () => {
  const { code, lines } = runPair(renamedOriginal(), renamedClone(), ['--ignore-locals']);
  assert.equal(code, 2, 'renamed clone must be detected');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^src\/a\.js:2: /);
  assert.match(lines[1], /^src\/b\.js:2: /);
  assert.equal(lines[2], '2/2 files over 1% duplication\n');
});

test('renamed clone passes without ignore-locals (back-compat)', () => {
  const { code } = runPair(renamedOriginal(), renamedClone(), []);
  assert.equal(code, 0, 'default mode is Type-1 only');
});

test('ignore-literals masks string and numeric literals', () => {
  const masked = runPair(
    literal('process', 100, 'alpha'),
    literal('handle', 200, 'beta'),
    ['--ignore-literals'],
  );
  assert.equal(masked.code, 2, 'literals must be masked');
  const raw = runPair(literal('process', 100, 'alpha'), literal('handle', 200, 'beta'), []);
  assert.equal(raw.code, 0, 'without ignore-literals literals stay visible');
});

test('locals of every declaration kind are renamed', () => {
  const { code } = runPair(
    kinds('run', 'input', 'head', 'tail', 'count', 'piece', 'helper', 'err'),
    kinds('go', 'source', 'first', 'rest', 'total', 'part', 'assist', 'problem'),
    ['--ignore-locals'],
  );
  assert.equal(code, 2, 'destructuring, loop vars, local functions, catch params renamed');
});

test('swapped locals never match under ignore-locals', () => {
  const { code } = runPair(
    swappable('calc', 'alpha', 'beta', 'total'),
    swapped('handle', 'first', 'second', 'sum'),
    ['--ignore-locals'],
  );
  assert.equal(code, 0, 'consistent renaming keeps a/b != y/x');
});

test('different called methods never match', () => {
  // 50-token windows: the shared masked prefix between the renamed header
  // and the first call is shorter than the window, so no window can avoid
  // the differing method name.
  const { code } = runPair(
    callee('process', 'values', 'result', 'add'),
    callee('handle', 'data', 'out', 'push'),
    ['--ignore-locals'],
    '50',
  );
  assert.equal(code, 0, 'API surface (called method names) stays visible');
});

test('field references stay visible under ignore-locals', () => {
  const { code } = runPair(
    repo('RepoA', '_cache', 'key', 'value'),
    repo('RepoB', '_store', 'name', 'raw'),
    ['--ignore-locals'],
  );
  assert.equal(code, 0, 'field names are API surface, not locals');
});

test('exact copy never lost when scopes shift placeholder numbering', () => {
  // The masked pass misses this pair (leading locals shift $L numbering);
  // the union with the raw pass must still detect it.
  const root = fixture({ 'src/a.js': shiftedScope(), 'src/b.js': plainScope() });
  try {
    const ctx = fakeCtx(root);
    const code = runDuplicates(
      ['--min-tokens', '5', '--min-lines', '2', '--ignore-locals', 'src'],
      ctx,
    );
    assert.equal(code, 2, 'raw pass must keep Type-1 detection under masking');
  } finally {
    cleanup(root);
  }
});

test('template literals embed renamable locals under ignore-locals', () => {
  const matched = runPair(
    interpolated('process', 'who'),
    interpolated('handle', 'name'),
    ['--ignore-locals'],
  );
  assert.equal(matched.code, 2, 'embedded locals are renamed consistently');
  const raw = runPair(interpolated('process', 'who'), interpolated('handle', 'name'), []);
  assert.equal(raw.code, 0, 'raw lexemes keep the embedded local visible');
});

test('constructor parameter properties are API surface (TS)', () => {
  const tsClass = (name, prop) => `
export class ${name} {
  count = 0;
  label = '';
  constructor(private ${prop}) {
    this.count = ${prop}.length;
    this.label = String(${prop}).slice(0, 3);
  }
}
`;
  const root = fixture({
    'src/a.ts': tsClass('Store', 'data'),
    'src/b.ts': tsClass('Vault', 'payload'),
  });
  try {
    const ctx = fakeCtx(root);
    const code = runDuplicates(
      ['--min-tokens', '20', '--min-lines', '2', '--ignore-locals', 'src'],
      ctx,
    );
    assert.equal(code, 0, 'TS parameter properties reference API state');
  } finally {
    cleanup(root);
  }
});

test('parseDuplicateArgs: boolean normalization flags are bare and opt-in', () => {
  assert.deepEqual(parseDuplicateArgs(['--ignore-locals', '--ignore-literals']), {
    threshold: 1,
    minTokens: 50,
    minLines: 5,
    exclude: [],
    source: [],
    paths: [],
    ignoreLocals: true,
    ignoreLiterals: true,
  });
  // Absent means false: the defaults object gains no keys (pinned above).
  assert.equal(parseDuplicateArgs([]).ignoreLocals, undefined);
  // Value syntax is reserved for value flags — a boolean flag with `=`
  // is rejected like any unknown flag (upstream's unknown-key rejection).
  assert.throws(() => parseDuplicateArgs(['--ignore-localss=x']), /unknown flag: --ignore-localss/);
  assert.throws(() => parseDuplicateArgs(['--ignore-locals=false']), /unknown flag: --ignore-locals/);
});
