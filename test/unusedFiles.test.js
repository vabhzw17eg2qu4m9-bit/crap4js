import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  runUnusedFiles,
  unusedFilesSummary,
  unusedFilesViolations,
} from '../src/unusedFiles.js';
import { gateFiles } from '../src/files.js';
import { resolveImport } from '../src/imports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fakeCtx(cwd) {
  const out = [];
  return {
    cwd,
    out: { write: (s) => out.push(s) },
    lines: out,
  };
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-unused-files-'));
  mkdirSync(path.join(root, 'src'));
  for (const [name, source] of Object.entries(files)) {
    const p = path.join(root, 'src', ...name.split('/'));
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, source);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test('files never imported by an analyzed source file are flagged', () => {
  const root = fixture({
    // a imports b (extensionless relative); c and d are imported by nobody
    // — and neither is a itself (an entry file is still unused here).
    'a.js': "import { b } from './b';\nexport const a = b;\n",
    'b.js': 'export const b = 1;\n',
    'c.js': 'export const c = 2;\n',
    'd.js': "import lodash from 'lodash';\nexport const d = lodash;\n",
  });
  try {
    const { violations, checked } = unusedFilesViolations(gateFiles([], root), root);
    assert.equal(checked, 4);
    const flagged = violations.map((v) => v.file).sort();
    assert.deepEqual(flagged, ['src/a.js', 'src/c.js', 'src/d.js']);
    assert.match(violations[0].message, /never imported by any analyzed source file/);
  } finally {
    cleanup(root);
  }
});

test('bare specifiers name external packages and never count', () => {
  const root = fixture({
    'x.js': "import { util } from 'node:util';\nimport fs from 'fs';\nexport const x = 1;\n",
  });
  try {
    const { violations } = unusedFilesViolations(gateFiles([], root), root);
    // x.js imports only external packages, so nothing project-internal
    // references it.
    assert.deepEqual(violations.map((v) => v.file), ['src/x.js']);
  } finally {
    cleanup(root);
  }
});

test('require and dynamic import specifiers count as imports', () => {
  const root = fixture({
    'main.js': [
      "const b = require('./b');",
      "const d = await import('./d.js');",
      'export const m = [b, d];',
    ].join('\n'),
    'b.js': 'export const b = 1;\n',
    'd.js': 'export const d = 2;\n',
  });
  try {
    const { violations } = unusedFilesViolations(gateFiles([], root), root);
    // b and d are imported via require/dynamic import; only main.js itself
    // is unreferenced.
    assert.deepEqual(violations.map((v) => v.file), ['src/main.js']);
  } finally {
    cleanup(root);
  }
});

test('directory imports resolve through index.js', () => {
  const root = fixture({
    'main.js': "import { helper } from './lib';\nexport const m = helper;\n",
    'lib/index.js': 'export const helper = 1;\n',
  });
  try {
    const { violations } = unusedFilesViolations(gateFiles([], root), root);
    assert.deepEqual(violations.map((v) => v.file), ['src/main.js']);
  } finally {
    cleanup(root);
  }
});

test('resolveImport resolves relative specifiers to project-relative paths', () => {
  const root = fixture({
    'main.js': "import './b.js';\n",
    'b.js': 'export const b = 1;\n',
  });
  try {
    const importer = path.join(root, 'src', 'main.js');
    assert.equal(resolveImport('./b.js', importer, root), 'src/b.js');
    assert.equal(resolveImport('./b', importer, root), 'src/b.js');
    assert.equal(resolveImport('./missing', importer, root), null);
    assert.equal(resolveImport('lodash', importer, root), null);
  } finally {
    cleanup(root);
  }
});

test('violations print one line per file and exit 2', () => {
  const root = fixture({ 'a.js': 'export const a = 1;\n' });
  try {
    const ctx = fakeCtx(root);
    assert.equal(runUnusedFiles([], ctx), 2);
    assert.match(ctx.lines.join(''), /src\/a\.js: never imported by any analyzed source file/);
    assert.match(ctx.lines.join(''), /1\/1 files never imported/);
  } finally {
    cleanup(root);
  }
});

test('explicit path selection skips with a message and exits 0', () => {
  const ctx = fakeCtx(__dirname);
  assert.equal(runUnusedFiles(['src'], ctx), 0);
  assert.match(ctx.lines.join(''), /not meaningful for a partial selection/);
});

test('unusedFilesSummary lines', () => {
  assert.equal(unusedFilesSummary({ violations: 0, checked: 3 }), '3 files all imported');
  assert.equal(unusedFilesSummary({ violations: 1, checked: 3 }), '1/3 files never imported');
});
