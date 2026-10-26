import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  folderStructureSummary,
  folderStructureViolations,
  parseFolderArgs,
  runFolderStructure,
} from '../src/folderStructure.js';

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

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function fixture() {
  return mkdtempSync(path.join(tmpdir(), 'crap4js-folder-structure-'));
}

test('more than max_loose_files direct source files are flagged', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'one.js'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'src', 'two.js'), 'export const b = 2;\n');
    // Organized: inside a subdirectory, not counted.
    writeFileSync(path.join(root, 'src', 'feature', 'three.js'), 'export const c = 3;\n');
    const { violations, checked } = folderStructureViolations(root);
    assert.equal(checked, 1);
    assert.deepEqual(violations, [
      {
        file: 'src',
        message:
          '2 loose files directly in src — group them into feature packages (max 0)',
      },
    ]);
  } finally {
    cleanup(root);
  }
});

test('organized src/ (only subdirectories) passes', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src', 'web'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'web', 'search.js'), 'export const s = 1;\n');
    const ctx = fakeCtx(root);
    assert.equal(runFolderStructure([], ctx), 0);
    assert.match(ctx.lines.join(''), /1 directories organized into packages/);
  } finally {
    cleanup(root);
  }
});

test('missing src/ directory checks nothing and passes', () => {
  const root = fixture();
  try {
    const { violations, checked } = folderStructureViolations(root);
    assert.equal(checked, 0);
    assert.deepEqual(violations, []);
  } finally {
    cleanup(root);
  }
});

test('violations print one line plus the summary and exit 2', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'loose.js'), 'export const a = 1;\n');
    const ctx = fakeCtx(root);
    assert.equal(runFolderStructure([], ctx), 2);
    assert.match(
      ctx.lines.join(''),
      /src: 1 loose files directly in src — group them into feature packages \(max 0\)/,
    );
    assert.match(ctx.lines.join(''), /1 directory\(ies\) with loose-file sprawl/);
  } finally {
    cleanup(root);
  }
});

test('any argument is a usage error (exit 1)', () => {
  const root = fixture();
  try {
    const ctx = fakeCtx(root);
    assert.throws(() => runFolderStructure(['src'], ctx), /unknown argument: src/);
  } finally {
    cleanup(root);
  }
});

test('folderStructureSummary lines', () => {
  assert.equal(
    folderStructureSummary({ violations: 0, checked: 1 }),
    '1 directories organized into packages',
  );
  assert.equal(
    folderStructureSummary({ violations: 1, checked: 1 }),
    '1 directory(ies) with loose-file sprawl',
  );
});

test('CLI dispatch: folder-structure exits 2 on a loose src/', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'loose.js'), 'export const a = 1;\n');
    const r = spawnSync(process.execPath, [CLI, 'folder-structure'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /1 loose files directly in src/);
  } finally {
    cleanup(root);
  }
});

test('a parent is never flagged for files in subdirectories', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src', 'pkg'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'one.js'), 'export const a = 1;\n');
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(root, 'src', 'pkg', `f${i}.js`), `export const x${i} = ${i};\n`);
    }
    // Only the 1 direct unit counts; subtree counting would flag 6.
    const { violations } = folderStructureViolations(root, { dirs: ['src'], maxLooseFiles: 1 });
    assert.deepEqual(violations, []);
  } finally {
    cleanup(root);
  }
});

test('generated siblings collapse into one logical unit', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'magic.js'), 'export const m = 1;\n');
    writeFileSync(path.join(root, 'src', 'magic.d.ts'), 'export declare const m: number;\n');
    writeFileSync(path.join(root, 'src', 'magic.min.js'), 'const m=1;');
    const pass = folderStructureViolations(root, { dirs: ['src'], maxLooseFiles: 1 });
    assert.deepEqual(pass.violations, []);
    writeFileSync(path.join(root, 'src', 'other.js'), 'export const o = 2;\n');
    const fail = folderStructureViolations(root, { dirs: ['src'], maxLooseFiles: 1 });
    assert.deepEqual(fail.violations.map((v) => v.message), [
      '2 loose files directly in src — group them into feature packages (max 1)',
    ]);
  } finally {
    cleanup(root);
  }
});

test('--dir glob expands to matching directories', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src', 'one'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'two'), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(root, 'src', 'one', `f${i}.js`), `export const x = ${i};\n`);
      writeFileSync(path.join(root, 'src', 'two', `g${i}.js`), `export const y = ${i};\n`);
    }
    const { violations, checked } = folderStructureViolations(root, {
      dirs: ['src/*'],
      maxLooseFiles: 2,
    });
    assert.equal(checked, 2);
    assert.deepEqual(violations.map((v) => v.file), ['src/one', 'src/two']);
  } finally {
    cleanup(root);
  }
});

test('glob expansion skips hidden and build directories', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, '.git', 'refs'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    mkdirSync(path.join(root, 'dist'));
    writeFileSync(path.join(root, 'dist', 'bundle.js'), 'x();\n');
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
    const { violations } = folderStructureViolations(root, { dirs: ['**'], maxLooseFiles: 0 });
    assert.deepEqual(violations.map((v) => v.file), ['src']);
  } finally {
    cleanup(root);
  }
});

test('--cap gives each pattern its own cap and wins over --dir/--max-loose-files', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'f0.js'), 'export const a = 0;\n');
    writeFileSync(path.join(root, 'src', 'f1.js'), 'export const b = 1;\n');
    mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(path.join(root, 'src', 'generated', `g${i}.js`), `export const g = ${i};\n`);
    }
    // src holds 2 units (cap 1) — flagged; generated holds 10 units but
    // cap 20 — clean; --dir/--max-loose-files are not consulted.
    const { violations } = folderStructureViolations(root, {
      caps: [
        { pattern: 'src', cap: 1 },
        { pattern: 'src/**', cap: 20 },
      ],
      dirs: ['src'],
      maxLooseFiles: 99,
    });
    assert.deepEqual(violations.map((v) => v.message), [
      '2 loose files directly in src — group them into feature packages (max 1)',
    ]);
  } finally {
    cleanup(root);
  }
});

test('a directory matched by several caps uses the first cap', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src', 'x'), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(root, 'src', 'x', `f${i}.js`), `export const f = ${i};\n`);
    }
    const first = folderStructureViolations(root, {
      caps: [
        { pattern: 'src/x', cap: 5 },
        { pattern: 'src/**', cap: 1 },
      ],
    });
    assert.deepEqual(first.violations, []);
    const flipped = folderStructureViolations(root, {
      caps: [
        { pattern: 'src/**', cap: 1 },
        { pattern: 'src/x', cap: 5 },
      ],
    });
    assert.equal(flipped.violations.length, 1);
    assert.match(flipped.violations[0].message, /\(max 1\)/);
  } finally {
    cleanup(root);
  }
});

test('--exclude drops files from the count', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src'));
    for (let i = 0; i < 3; i++) {
      writeFileSync(path.join(root, 'src', `f${i}.js`), `export const f = ${i};\n`);
    }
    writeFileSync(path.join(root, 'src', 'huge.d.ts'), 'export declare type T = never;\n');
    const without = folderStructureViolations(root, { dirs: ['src'], maxLooseFiles: 3 });
    assert.equal(without.violations.length, 1);
    const withExclude = folderStructureViolations(root, {
      dirs: ['src'],
      maxLooseFiles: 3,
      exclude: ['**.d.ts'],
    });
    assert.deepEqual(withExclude.violations, []);
  } finally {
    cleanup(root);
  }
});

test('caps and thresholds are strictly validated', () => {
  assert.throws(() => parseFolderArgs(['--cap', 'src:many']), /Invalid --cap: src:many/);
  assert.throws(() => parseFolderArgs(['--cap', 'src']), /Invalid --cap: src/);
  assert.throws(() => parseFolderArgs(['--cap', 'src:-1']), /Invalid --cap: src:-1/);
  // Number() alone would accept all of these ('' as 0, hex, exponent).
  assert.throws(() => parseFolderArgs(['--cap', 'src:']), /Invalid --cap: src:/);
  assert.throws(() => parseFolderArgs(['--cap', 'src:0x2']), /Invalid --cap: src:0x2/);
  assert.throws(() => parseFolderArgs(['--cap', 'src:1e2']), /Invalid --cap: src:1e2/);
  assert.throws(() => parseFolderArgs(['--max-loose-files', '2.5']), /Invalid --max-loose-files/);
});

test('flags parse into the documented opts shape', () => {
  assert.deepEqual(
    parseFolderArgs(['--dir', 'lib/src', '--dir=packages/*', '--max-loose-files', '5', '--cap', 'src:8', '--exclude', '**.min.js']).caps,
    [{ pattern: 'src', cap: 8 }],
  );
});

test('CLI dispatch: --cap drives the verdict', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'src', 'b.js'), 'export const b = 2;\n');
    const flagged = spawnSync(process.execPath, [CLI, 'folder-structure', '--cap', 'src:1'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(flagged.status, 2);
    assert.match(flagged.stdout, /\(max 1\)/);
    const clean = spawnSync(process.execPath, [CLI, 'folder-structure', '--cap', 'src:5'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /1 directories organized into packages/);
  } finally {
    cleanup(root);
  }
});

test('directory symlinks are never followed: no cycles, no double flags', () => {
  const root = fixture();
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
    // A symlinked directory (alias -> src) must not be enumerated, and a
    // symlink cycle (loop -> the project root) must not crash the walk.
    symlinkSync('src', path.join(root, 'alias'));
    symlinkSync('..', path.join(root, 'src', 'loop'));
    const { violations } = folderStructureViolations(root, { dirs: ['**'], maxLooseFiles: 0 });
    assert.deepEqual(violations.map((v) => v.file), ['src']);
  } finally {
    cleanup(root);
  }
});
