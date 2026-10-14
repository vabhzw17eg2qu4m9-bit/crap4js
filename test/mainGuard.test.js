import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain, samePath } from '../src/mainGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'src', 'cli.js');
const WIN = process.platform === 'win32';

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', ...opts });
}

function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* best effort */
  }
}

// Symlink helper: junctions cover directory links on Windows without
// privileges; plain symlinks everywhere else.
function linkDir(target, link) {
  symlinkSync(target, link, WIN ? 'junction' : 'dir');
}

const symProbe = {};

// Capability probe, cached per kind. Skips must stay honest: only tests the
// platform genuinely cannot run are skipped, and the reason says why.
function canSymlink(kind) {
  if (!(kind in symProbe)) {
    const dir = mkdtempSync(path.join(tmpdir(), 'crap4js-symprobe-'));
    try {
      if (kind === 'file') {
        const target = path.join(dir, 'target.js');
        writeFileSync(target, '');
        symlinkSync(target, path.join(dir, 'link.js'), 'file');
      } else {
        linkDir(dir, path.join(dir, 'link'));
      }
      symProbe[kind] = true;
    } catch {
      symProbe[kind] = false;
    } finally {
      cleanup(dir);
    }
  }
  return symProbe[kind];
}

const NO_DIR_LINK = canSymlink('dir')
  ? false
  : 'platform forbids symlink creation (probed)';
const NO_FILE_LINK = canSymlink('file')
  ? false
  : 'platform forbids symlink creation (probed)';

// npm is broken on some dev hosts (cannot read its own package.json); the
// probe below skips only such hosts. CI images ship a working npm, so the
// E2E test must run there.
const npmCmd = WIN ? 'npm.cmd' : 'npm';
const NPM_WORKS = (() => {
  const r = spawnSync(npmCmd, ['--version'], {
    encoding: 'utf8',
    shell: WIN,
  });
  return r.status === 0;
})();

// A temp real dir holding mod.js plus a symlinked-directory spelling of it.
// argv1 keeps the as-given (symlinked) path; a real ESM loader canonicalizes
// import.meta.url to the realpath, so metaUrl is built from the realpath.
function symlinkedEntryFixture() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'crap4js-guard-'));
  const real = path.join(tmp, 'real');
  const link = path.join(tmp, 'link');
  mkdirSync(real, { recursive: true });
  writeFileSync(path.join(real, 'mod.js'), 'export {};\n');
  linkDir(real, link);
  return {
    tmp,
    argv1: path.join(link, 'mod.js'),
    metaUrl: pathToFileURL(realpathSync(path.join(link, 'mod.js'))).href,
  };
}

test('UT-1: importing cli.js as a library runs nothing (no exit, exports intact)', async () => {
  // If the entry guard misfired, this import would have called main() and
  // process.exit(), killing the test process before these assertions.
  const cli = await import('../src/cli.js');
  assert.equal(typeof cli.main, 'function');
  assert.equal(typeof cli.parseArgs, 'function');
  assert.equal(typeof cli.usage, 'function');
});

test('UT-2: isMain with absent or dangling argv[1] is false and never throws', () => {
  const url = pathToFileURL(CLI).href;
  assert.equal(isMain(url, undefined), false);
  assert.equal(isMain(url), false);
  assert.equal(isMain(url, path.join(__dirname, 'no-such-file.js')), false);
});

test('UT-3: samePath accepts Windows drive-letter pairs (pure logic)', () => {
  // C:\... vs file:///C:/... — the exact pair the naive template could
  // never reconcile on Windows.
  assert.equal(samePath('C:\\Users\\me\\cli.js', 'file:///C:/Users/me/cli.js'), true);
  assert.equal(samePath('C:\\Users\\me\\cli.js', 'C:/Users/me/cli.js'), true);
  assert.equal(samePath('c:\\users\\ME\\cli.js', 'C:\\Users\\me\\cli.js'), true);
  assert.equal(samePath('C:\\a\\\\b\\cli.js', 'C:\\a\\b\\cli.js'), true);
  assert.equal(samePath('C:\\Users\\me\\cli.js', 'C:\\Users\\other\\cli.js'), false);
  assert.equal(samePath('C:\\Users\\me\\cli.js', 'file:///C:/Users/other/cli.js'), false);
  // POSIX side stays strict (no URL form here: fileURLToPath rejects
  // drive-less file URLs on Windows, so URL fixtures are drive-letter only).
  assert.equal(samePath('/tmp/a/cli.js', '/tmp/a/cli.js/'), true);
  assert.equal(samePath('/tmp/a/cli.js', '/tmp/a/other.js'), false);
  assert.equal(samePath(undefined, 'x'), false);
  assert.equal(samePath('x', undefined), false);
});

test('UT-4 pin: the one-sided pathToFileURL idiom does NOT fix symlinked dirs (issue #42 F4)', () => {
  const f = symlinkedEntryFixture();
  try {
    // The Node-docs idiom compares pathToFileURL(argv[1]).href — argv[1]
    // keeps the symlinked spelling, so it still mismatches the realpath URL:
    assert.notEqual(pathToFileURL(f.argv1).href, f.metaUrl);
    assert.notEqual(f.metaUrl, `file://${f.argv1}`);
    // Dual realpath is what actually matches:
    assert.equal(isMain(f.metaUrl, f.argv1), true);
  } finally {
    cleanup(f.tmp);
  }
});

test('isMain accepts direct and case-differing invocation spellings', () => {
  const url = pathToFileURL(CLI).href;
  assert.equal(isMain(url, CLI), true);
  // A different real file is not the entry:
  assert.equal(
    isMain(url, path.join(__dirname, 'mainGuard.test.js')),
    false,
  );
});

test('E6: case-differing invocation path still runs the CLI', { skip: process.platform === 'linux' }, () => {
  // On case-insensitive filesystems (macOS, Windows) users may type the
  // path with different casing. realpath preserves the caller's casing, so
  // both guard sides carry the same spelling and the CLI must run. (The
  // file stem stays lowercase: Node's ESM loader rejects `.JS` extensions.)
  const r = runNode([path.join(REPO, 'SRC', 'cli.js'), '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
});

test('IT-1: CLI through a symlinked directory prints usage, exit 0', { skip: NO_DIR_LINK }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'crap4js-guard-'));
  try {
    const link = path.join(tmp, 'repo-link');
    linkDir(REPO, link);
    const r = runNode([path.join(link, 'src', 'cli.js'), '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
  } finally {
    cleanup(tmp);
  }
});

test('IT-2: CLI through a symlinked directory analyzes a fixture dir', { skip: NO_DIR_LINK }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'crap4js-guard-'));
  try {
    const project = path.join(tmp, 'project');
    mkdirSync(path.join(project, 'src'), { recursive: true });
    writeFileSync(path.join(project, 'src', 'a.js'), 'function f() { return 1; }\n');
    const link = path.join(tmp, 'project-link');
    linkDir(project, link);
    const cliLink = path.join(tmp, 'repo-link');
    linkDir(REPO, cliLink);
    const r = runNode([path.join(cliLink, 'src', 'cli.js'), link], {
      cwd: tmp,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CRAP Report/);
  } finally {
    cleanup(tmp);
  }
});

test('IT-3: --preserve-symlinks-main keeps the guard working through symlinks', { skip: NO_DIR_LINK }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'crap4js-guard-'));
  try {
    const link = path.join(tmp, 'repo-link');
    linkDir(REPO, link);
    const r = runNode([
      '--preserve-symlinks-main',
      path.join(link, 'src', 'cli.js'),
      '--help',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
  } finally {
    cleanup(tmp);
  }
});

test('E2: CLI invoked through a symlinked FILE runs', { skip: NO_FILE_LINK }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'crap4js-guard-'));
  try {
    const link = path.join(tmp, 'cli-link.js');
    symlinkSync(CLI, link, 'file');
    const r = runNode([link, '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
  } finally {
    cleanup(tmp);
  }
});

test('E7: relative entry path from a symlinked cwd still runs the CLI', { skip: NO_DIR_LINK }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'crap4js-guard-'));
  try {
    const link = path.join(tmp, 'repo-link');
    linkDir(REPO, link);
    // argv[1] stays relative ('src/cli.js'); the child cwd is the link.
    const r = runNode([path.join('src', 'cli.js'), '--help'], { cwd: link });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
  } finally {
    cleanup(tmp);
  }
});

test('E2E: npm-packaged CLI installed with symlinked node_modules runs via npx', {
  skip: NPM_WORKS
    ? false
    : 'npm is unavailable/broken on this host (probed via `npm --version`); runs in CI where npm works',
}, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'crap4js-e2e-'));
  try {
    const packDir = path.join(tmp, 'pack');
    const prefix = path.join(tmp, 'prefix');
    const linkRoot = path.join(tmp, 'linkroot');
    mkdirSync(packDir, { recursive: true });
    const packed = spawnSync(npmCmd, ['pack', REPO, '--pack-destination', packDir], {
      encoding: 'utf8',
      shell: WIN,
      cwd: packDir,
    });
    assert.equal(packed.status, 0, packed.stderr);
    const tgz = path.join(packDir, packed.stdout.trim().split('\n').pop().trim());
    const installed = spawnSync(npmCmd, ['install', '--prefix', prefix, tgz], {
      encoding: 'utf8',
      shell: WIN,
    });
    assert.equal(installed.status, 0, installed.stderr);
    // Symlinked node_modules: bin shim and module path both resolve through
    // the link — the layout npx hits through a symlinked prefix
    // (/tmp -> /private/tmp on macOS).
    mkdirSync(linkRoot, { recursive: true });
    linkDir(path.join(prefix, 'node_modules'), path.join(linkRoot, 'node_modules'));
    const r = spawnSync('npx', ['crap4js', '--help'], {
      encoding: 'utf8',
      shell: WIN,
      cwd: linkRoot,
      env: {
        ...process.env,
        PATH:
          path.join(linkRoot, 'node_modules', '.bin') +
          path.delimiter +
          process.env.PATH,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage:/);
  } finally {
    cleanup(tmp);
  }
});
