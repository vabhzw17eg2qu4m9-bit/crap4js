import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
}

test('skill prints adapted skill text and exits 0', () => {
  const r = runCli(['skill']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^# crap4js Profiling Skill\n/);
  assert.match(r.stdout, /node --test/);
  assert.match(r.stdout, /profile-reports\//);
  assert.match(r.stdout, /@60fps\(ms\)/);
  assert.ok(r.stdout.trimEnd().split('\n').length < 90, 'skill output too long');
});

test('skill ends with an install line', () => {
  const r = runCli(['skill']);
  const last = r.stdout.trimEnd().split('\n').pop();
  assert.match(last, /mkdir -p \.agents\/skills\/crap4js-profiling/);
});

test('profile with unknown flag exits 1 with usage', () => {
  const r = runCli(['profile', '--bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown flag/);
});
