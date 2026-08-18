import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  folderStructureSummary,
  folderStructureViolations,
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
