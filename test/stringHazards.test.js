import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  runStringHazards,
  stringHazardsViolations,
  stringHazardsSummary,
} from '../src/stringHazards.js';

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

function fixture(lines) {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-string-hazards-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.js'), `${lines.join('\n')}\n`);
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function violationsOf(lines) {
  const root = fixture(lines);
  try {
    return stringHazardsViolations([path.join(root, 'src', 'a.js')], root).violations;
  } finally {
    cleanup(root);
  }
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

// --- Shape 1: escaped interpolation in template literals -----------------

test('flags escaped template interpolation with sibling evidence', () => {
  const v = violationsOf([
    'const msg = `hello \\${name}, bye \\${name}`;',
    'const real = `${name}`;',
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 1);
  assert.match(v[0].message, /escaped interpolation '\\\$name' renders literal '\$name'/);
  assert.match(v[0].message, /interpolated elsewhere in this file — stray backslash\?/);
});

test('flags escaped brace form with sibling interpolation', () => {
  const v = violationsOf([
    'const a = `\\${name} escaped`;',
    'const b = `${name} real`;',
  ]);
  assert.equal(v.length, 1);
});

test('spares escaped dollars without sibling evidence or identifier', () => {
  // `\$HOME` records an occurrence, but nothing interpolates HOME here —
  // the sibling-evidence rule keeps deliberate shell text quiet.
  assert.deepEqual(violationsOf(['run(`export HOME=\\$HOME && echo ok`);']), []);
  // No identifier after `\$` — never an occurrence at all.
  assert.deepEqual(violationsOf(['log(`costs \\$100 and ends \\$`);']), []);
});

test('plain strings are not interpolation — only template literals count', () => {
  const v = violationsOf([
    "log('price \\${name} in plain text');",
    'log(`price \\${name} in template`);',
    'const total = `${name}`;',
  ]);
  // The plain string renders literally anyway (no hazard in JS); only the
  // template quasi is flagged.
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
});

test('spares String.raw tagged templates', () => {
  const v = violationsOf([
    'const raw = String.raw`\\${name} stays`;',
    'const real = `${name}`;',
  ]);
  assert.deepEqual(v, []);
});

test('escaped backslash never reads as an escaped dollar', () => {
  const v = violationsOf([
    'const p = `C:\\\\${name}`;',
    'const real = `${name}`;',
  ]);
  assert.deepEqual(v, []);
});

test('serves each occurrence line once', () => {
  const v = violationsOf([
    'log(`\\${name}`);',
    'log(`\\${name} and \\${name}`);',
    'log(`${name}`);',
  ]);
  assert.deepEqual(v.map((x) => x.line), [1, 2]);
});

test('prefixed and chained interpolations expose their root', () => {
  const v = violationsOf([
    'log(`\\${user.name} escaped`);',
    'log(`${user.name} real`);',
    'log(`\\${a.b.c} escaped`);',
    'log(`${a.b.c} real`);',
  ]);
  assert.equal(v.length, 2);
});

test('method-call interpolations expose their receiver', () => {
  const v = violationsOf([
    'log(`\\${builder.build()} escaped`);',
    'log(`${builder.build()} real`);',
  ]);
  assert.equal(v.length, 1);
});

test('calls and index expressions provide no sibling name', () => {
  const v = violationsOf([
    'function g() {}',
    'log(`\\${g()} one`);',
    'log(`${g()} two`);',
    'log(`\\${list[0]} one`);',
    'log(`${list[0]} two`);',
  ]);
  assert.deepEqual(v, []);
});

// --- Shape 2: RegExp sources with an escaped anchor -----------------------

test('flags a regex literal ending with an escaped dollar', () => {
  const v = violationsOf(['const re = /[0-9a-f]{12}\\$/;']);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /not the end anchor/);
});

test('flags a regex literal starting with an escaped caret', () => {
  const v = violationsOf(['const re = /\\^abc/;']);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /not the start anchor/);
});

test('spares plain regex anchors', () => {
  assert.deepEqual(violationsOf([
    'const a = /[0-9a-f]{12}$/;',
    'const b = /^abc/;',
  ]), []);
});

test('flags RegExp factory and constructor calls with escaped-anchor strings', () => {
  const v = violationsOf([
    "const a = new RegExp('^[0-9]{12}\\\\$');",
    "const b = RegExp('\\\\^abc');",
  ]);
  assert.equal(v.length, 2);
});

test('spares RegExp calls with plain anchors and non-literal arguments', () => {
  assert.deepEqual(violationsOf([
    "const a = new RegExp('^[a-z]+$');",
    "const p = 'x\\\\$';",
    'const b = new RegExp(p);',
  ]), []);
});

test('spares escaped dollars outside regex context', () => {
  assert.deepEqual(violationsOf(["const s = 'costs 5\\$';"]), []);
});

// --- Shape 3: anchors in literal String patterns --------------------------

test('flags leading caret in a replace string pattern', () => {
  const v = violationsOf(["const x = path.replace('^~/', '/');"]);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /starts with '\^'/);
  assert.match(v[0].message, /a RegExp was probably intended/);
});

test('flags trailing dollar in replaceAll and split string patterns', () => {
  const v = violationsOf([
    "const y = s.replaceAll('abc$', '');",
    "const z = s.split('^');",
  ]);
  assert.equal(v.length, 2);
  assert.match(v[0].message, /ends with '\$'/);
});

test('spares regex search values and non-literal patterns', () => {
  assert.deepEqual(violationsOf([
    'const a = s.split(/,/);',
    "const b = s.replace(/^a/, '');",
    "const p = '^a';",
    "const c = s.replace(p, '');",
  ]), []);
});

test('spares unanchored patterns', () => {
  assert.deepEqual(violationsOf(["const x = s.replace('abc', 'x');"]), []);
});

test('spares escaped trailing dollar', () => {
  assert.deepEqual(violationsOf(["const w = s.replace('abc\\\\$', '');"]), []);
});

test('bare method-name calls are skipped', () => {
  assert.deepEqual(violationsOf(['const r = split(x);']), []);
});

test('checks only the pattern argument', () => {
  const v = violationsOf(["const v = s.replace('^a', '^b');"]);
  assert.equal(v.length, 1);
  assert.match(v[0].message, /starts with '\^'/);
});

// --- Severity, flags, ignore wiring ---------------------------------------

test('warning severity reports violations and exits 0 by default', () => {
  const root = fixture(["const x = s.replace('^a', 'b');"]);
  try {
    // No path arguments — the default src/ selection applies.
    const r = runCli(root, ['string-hazards']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /src\/a\.js:1: literal pattern starts with/);
    assert.match(r.stdout, /1 string hazard\(s\) in 1 files/);
  } finally {
    cleanup(root);
  }
});

test('--severity error makes violations exit 2', () => {
  const root = fixture(["const x = s.replace('^a', 'b');"]);
  try {
    const r = runCli(root, ['string-hazards', '--severity', 'error']);
    assert.equal(r.status, 2);
    const eq = runCli(root, ['string-hazards', '--severity=error']);
    assert.equal(eq.status, 2);
  } finally {
    cleanup(root);
  }
});

test('rejects unknown severity values and unknown flags', () => {
  const root = fixture(["const x = s.replace('^a', 'b');"]);
  try {
    const bad = runCli(root, ['string-hazards', '--severity', 'bogus']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--severity must be warning or error/);
    const flag = runCli(root, ['string-hazards', '--nope=x']);
    assert.equal(flag.status, 1);
    assert.match(flag.stderr, /unknown flag: --nope/);
  } finally {
    cleanup(root);
  }
});

test('ignore markers suppress findings', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'crap4js-string-hazards-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.js'), [
    "const x = s.replace('^a', 'b'); // ignore:string-hazards",
    "// crap:ignore",
    "const y = s.replaceAll('b$', 'c');",
  ].join('\n'));
  try {
    const r = runCli(root, ['string-hazards', '--severity=error']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /free of string hazards/);
  } finally {
    cleanup(root);
  }
});

test('passes on clean files', () => {
  const root = fixture([
    'const re = /^[a-z]+$/;',
    "const s = 'plain string';",
    'const t = `interpolated ${s} value`;',
    "const u = s.replace('a', 'b');",
    'const w = String.raw`raw \\${s} text`;',
  ]);
  try {
    const result = stringHazardsViolations([path.join(root, 'src', 'a.js')], root);
    assert.deepEqual(result.violations, []);
    assert.equal(
      stringHazardsSummary({ violations: result.violations.length, checked: result.checked }),
      '1 files free of string hazards',
    );
  } finally {
    cleanup(root);
  }
});

test('runStringHazards returns 0 on warning findings via ctx', () => {
  const root = fixture(["const x = s.split('^');"]);
  try {
    const code = runStringHazards([], fakeCtx(root));
    assert.equal(code, 0);
  } finally {
    cleanup(root);
  }
});
