import test from 'node:test';
import assert from 'node:assert';
import { coverageForMethod, loadCoverage } from '../src/coverage.js';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('attributes covered/total for statements in range', () => {
  const fileCoverage = {
    statementMap: {
      '0': { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } },
      '1': { start: { line: 6, column: 0 }, end: { line: 6, column: 12 } },
      '2': { start: { line: 7, column: 0 }, end: { line: 7, column: 5 } },
    },
    s: { '0': 3, '1': 0, '2': 1 },
  };
  // method covers lines 5-7: 2 of 3 covered
  assert.equal(coverageForMethod(fileCoverage, 5, 7), 2 / 3);
});

test('partial overlap still intersects (statement crosses boundary)', () => {
  const fileCoverage = {
    statementMap: {
      '0': { start: { line: 4, column: 0 }, end: { line: 6, column: 0 } },
    },
    s: { '0': 2 },
  };
  // method 5-10 intersects statement 4-6
  assert.equal(coverageForMethod(fileCoverage, 5, 10), 1);
});

test('returns null when no statements intersect the range', () => {
  const fileCoverage = {
    statementMap: {
      '0': { start: { line: 100, column: 0 }, end: { line: 100, column: 5 } },
    },
    s: { '0': 5 },
  };
  assert.equal(coverageForMethod(fileCoverage, 5, 10), null);
});

test('returns null when fileCoverage is null or missing statementMap', () => {
  assert.equal(coverageForMethod(null, 1, 10), null);
  assert.equal(coverageForMethod({}, 1, 10), null);
});

test('counts only hit statements as covered', () => {
  const fileCoverage = {
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
      '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 1 } },
    },
    s: { '0': 0, '1': 0 },
  };
  assert.equal(coverageForMethod(fileCoverage, 1, 2), 0);
});

// A checkout reached through a symlink makes the coverage keys and the project
// root spell the same file differently. Every entry then looks external, the
// map comes back empty, and the run reports a clean bill of health. The alias
// can sit on either side of the comparison, and can coincide with a source
// file that is itself a symlink, so the topologies are tested separately and
// together.

// Only a genuine lack of symlink support (unprivileged Windows) is a reason to
// skip; anything else is a real failure and must not be swallowed.
const NO_SYMLINK_SUPPORT = new Set(['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN']);

function trySymlink(target, linkPath, type) {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    if (NO_SYMLINK_SUPPORT.has(err.code)) return false;
    throw err;
  }
}

function project() {
  const base = mkdtempSync(path.join(tmpdir(), 'crap4js-cov-'));
  const real = path.join(base, 'real');
  mkdirSync(path.join(real, 'src'), { recursive: true });
  mkdirSync(path.join(real, 'generated'), { recursive: true });
  writeFileSync(path.join(real, 'src', 'a.js'), 'export const a = 1;\n');
  return { base, real, link: path.join(base, 'link') };
}

function writeCoverage(dir, entries) {
  const covPath = path.join(dir, 'coverage-final.json');
  const json = {};
  for (const key of entries) json[key] = { statementMap: {}, s: {} };
  writeFileSync(covPath, JSON.stringify(json));
  return covPath;
}

test('loadCoverage matches a symlinked coverage key against a real root', (t) => {
  const { base, real, link } = project();
  try {
    if (!trySymlink(real, link, 'dir')) return t.skip('symlinks unavailable');
    const cov = writeCoverage(base, [path.join(link, 'src', 'a.js')]);
    assert.deepEqual([...loadCoverage(cov, real).keys()], ['src/a.js']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loadCoverage matches a real coverage key against a symlinked root', (t) => {
  const { base, real, link } = project();
  try {
    if (!trySymlink(real, link, 'dir')) return t.skip('symlinks unavailable');
    const cov = writeCoverage(base, [path.join(real, 'src', 'a.js')]);
    assert.deepEqual([...loadCoverage(cov, link).keys()], ['src/a.js']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The analyzer looks coverage up by the path it walked to, so a source file
// that is itself a symlink must keep that spelling rather than its target's —
// including when the root is aliased too and the literal comparison cannot
// settle it.
test('loadCoverage keeps the walked spelling of a symlinked source file', (t) => {
  const { base, real } = project();
  try {
    rmSync(path.join(real, 'src', 'a.js'));
    writeFileSync(path.join(real, 'generated', 'a.impl'), 'export const a = 1;\n');
    if (!trySymlink(path.join(real, 'generated', 'a.impl'), path.join(real, 'src', 'a.js')))
      return t.skip('symlinks unavailable');
    const cov = writeCoverage(base, [path.join(real, 'src', 'a.js')]);
    assert.deepEqual([...loadCoverage(cov, real).keys()], ['src/a.js']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('loadCoverage keeps the walked spelling when the root is aliased too', (t) => {
  const { base, real, link } = project();
  try {
    rmSync(path.join(real, 'src', 'a.js'));
    writeFileSync(path.join(real, 'generated', 'a.impl'), 'export const a = 1;\n');
    if (
      !trySymlink(path.join(real, 'generated', 'a.impl'), path.join(real, 'src', 'a.js')) ||
      !trySymlink(real, link, 'dir')
    ) {
      return t.skip('symlinks unavailable');
    }
    const cov = writeCoverage(base, [path.join(real, 'src', 'a.js')]);
    assert.deepEqual([...loadCoverage(cov, link).keys()], ['src/a.js']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The same holds one level up: a symlinked *directory* below the root must
// keep its walked spelling too, so resolution has to stop at the root rather
// than canonicalising every component on the way down.
test('loadCoverage keeps the walked spelling of a symlinked directory', (t) => {
  const { base, real, link } = project();
  try {
    mkdirSync(path.join(real, 'generated', 'pkg'), { recursive: true });
    writeFileSync(
      path.join(real, 'generated', 'pkg', 'a.js'),
      'export const a = 1;\n',
    );
    if (
      !trySymlink(path.join(real, 'generated', 'pkg'), path.join(real, 'src', 'pkg'), 'dir') ||
      !trySymlink(real, link, 'dir')
    ) {
      return t.skip('symlinks unavailable');
    }
    const cov = writeCoverage(base, [path.join(real, 'src', 'pkg', 'a.js')]);
    assert.deepEqual([...loadCoverage(cov, link).keys()], ['src/pkg/a.js']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// A directory inside the project can resolve to the project root itself, so a
// key has more than one valid spelling and only the caller's input decides
// which the analyzer will ask for. Both are offered.
test('loadCoverage offers every spelling when a directory resolves to the root', (t) => {
  const { base, real, link } = project();
  try {
    if (
      !trySymlink(real, path.join(real, 'back'), 'dir') ||
      !trySymlink(real, link, 'dir')
    ) {
      return t.skip('symlinks unavailable');
    }
    const cov = writeCoverage(base, [path.join(link, 'back', 'src', 'a.js')]);
    assert.deepEqual(
      [...loadCoverage(cov, real).keys()].sort(),
      ['back/src/a.js', 'src/a.js'],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Two spellings of one file can carry different hit counts. The literal match
// is the one the analyzer will ask for, so it must win in either JSON order.
for (const aliasFirst of [true, false]) {
  test(`loadCoverage prefers the literal key over an aliased duplicate (alias ${
    aliasFirst ? 'first' : 'second'
  })`, (t) => {
    const { base, real, link } = project();
    try {
      if (!trySymlink(real, link, 'dir')) return t.skip('symlinks unavailable');
      const literal = path.join(real, 'src', 'a.js');
      const aliased = path.join(link, 'src', 'a.js');
      const covPath = path.join(base, 'coverage-final.json');
      const entry = (hits) => ({
        statementMap: { 0: { start: { line: 1 }, end: { line: 1 } } },
        s: { 0: hits },
      });
      writeFileSync(
        covPath,
        JSON.stringify(
          aliasFirst
            ? { [aliased]: entry(9), [literal]: entry(0) }
            : { [literal]: entry(0), [aliased]: entry(9) },
        ),
      );
      const map = loadCoverage(covPath, real);
      assert.deepEqual([...map.keys()], ['src/a.js']);
      assert.equal(map.get('src/a.js').s[0], 0, 'literal entry must win');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test('loadCoverage still drops entries genuinely outside the project root', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'crap4js-cov-out-'));
  try {
    const cov = writeCoverage(base, ['/elsewhere/lib/b.js']);
    assert.equal(loadCoverage(cov, base).size, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- mutation-survivor triage (upstream crap4dart 862acc1 practice) ---

test('statements with a null line boundary are never intersecting', () => {
  const fileCoverage = {
    statementMap: {
      broken: { start: { line: null }, end: { line: 5 } },
      good: { start: { line: 2 }, end: { line: 3 } },
    },
    s: { broken: 0, good: 1 },
  };
  // Only the well-formed statement counts: the null-boundary entry must be
  // skipped by the guard, not scored as an uncovered intersecting statement.
  assert.equal(coverageForMethod(fileCoverage, 1, 10), 1);
});

// --- lcov tracefiles (.info): same Map shape as the Istanbul JSON loader ---

function lcovProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'crap4js-lcov-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\nexport const b = 2;\n');
  return dir;
}

function writeLcov(dir, records, name = 'lcov.info', eol = '\n') {
  const infoPath = path.join(dir, name);
  writeFileSync(infoPath, records.join(eol) + eol);
  return infoPath;
}

test('loadCoverage parses an lcov .info into the Istanbul statement shape', () => {
  const dir = lcovProject();
  try {
    const info = writeLcov(dir, [
      'TN:',
      `SF:${path.join(dir, 'src', 'a.js')}`,
      'FN:1,(anonymous_0)',
      'FNDA:3,(anonymous_0)',
      'DA:1,5',
      'DA:2,0',
      'LF:2',
      'LH:1',
      'BRDA:1,0,0,3',
      'BRDA:1,0,1,0',
      'end_of_record',
    ]);
    const data = loadCoverage(info, dir).get('src/a.js');
    assert.deepEqual(data.statementMap, {
      '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 0 } },
    });
    assert.deepEqual(data.s, { '0': 5, '1': 0 });
    // FN/FNDA/BRDA/LF/LH/BRF/BRH carry no statements: exactly 2 of 3 records' lines.
    assert.equal(coverageForMethod(data, 1, 2), 1 / 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two SF records for one file sum their hits per line', () => {
  const dir = lcovProject();
  try {
    const sf = `SF:${path.join(dir, 'src', 'a.js')}`;
    const info = writeLcov(dir, [
      'TN:',
      sf,
      'DA:1,2',
      'DA:2,0',
      'end_of_record',
      sf,
      'DA:1,1',
      'DA:2,4',
      'end_of_record',
    ]);
    assert.deepEqual(loadCoverage(info, dir).get('src/a.js').s, { '0': 3, '1': 4 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CRLF lcov tracefiles parse', () => {
  const dir = lcovProject();
  try {
    const info = writeLcov(
      dir,
      ['TN:', `SF:${path.join(dir, 'src', 'a.js')}`, 'DA:1,7', 'end_of_record'],
      'lcov.info',
      '\r\n',
    );
    assert.deepEqual(loadCoverage(info, dir).get('src/a.js').s, { '0': 7 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relative SF paths resolve against the project root', () => {
  const dir = lcovProject();
  try {
    const info = writeLcov(dir, ['TN:', 'SF:src/a.js', 'DA:2,1', 'end_of_record']);
    assert.deepEqual([...loadCoverage(info, dir).keys()], ['src/a.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lcov records for files outside the project root are dropped', () => {
  const dir = lcovProject();
  try {
    const info = writeLcov(dir, [
      'TN:',
      `SF:${path.join(dir, 'src', 'a.js')}`,
      'DA:1,1',
      'end_of_record',
      'SF:/elsewhere/lib/b.js',
      'DA:1,9',
      'end_of_record',
    ]);
    const map = loadCoverage(info, dir);
    assert.deepEqual([...map.keys()], ['src/a.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed DA record is a parse error, not a silent skip', () => {
  const dir = lcovProject();
  try {
    const info = writeLcov(dir, ['TN:', 'SF:src/a.js', 'DA:oops', 'end_of_record']);
    assert.throws(() => loadCoverage(info, dir), /malformed lcov DA record: DA:oops/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a DA line outside every function counts for no function', () => {
  const dir = lcovProject();
  try {
    const info = writeLcov(dir, ['TN:', 'SF:src/a.js', 'DA:5,3', 'end_of_record']);
    const data = loadCoverage(info, dir).get('src/a.js');
    assert.equal(coverageForMethod(data, 1, 3), null);
    assert.equal(coverageForMethod(data, 6, 9), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
