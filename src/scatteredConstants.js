// `scattered-constants` subcommand: the corpus-wide sibling of
// magic-constants (port of crap4dart e766d68's scattered_constants gate,
// v2). magic-constants counts in-file repeats only, so a literal used once
// per file in K files is invisible to it — the 'change 86400 in every
// service' hazard. This gate counts DISTINCT files per literal value and
// distinguishes two findings:
//
// - constant regression: a `const` with the value already exists anywhere
//   in the corpus — every hardcoded re-introduction (a bare literal or a
//   duplicate local const, any occurrence count, even in the declaring
//   file) is flagged immediately, naming the constant and its file:line to
//   reference. No min_files wait: the fact has a home; the first
//   declaration wins when constants share a value.
// - scattered literal: no constant exists yet and the value reached
//   --min-files (default 3) distinct files — one violation per occurrence,
//   asking to extract a shared constant and verify all occurrences mean
//   the same thing first (the same value is sometimes coincidence).
//
// Values compare semantically: strings by value, numbers by numeric value
// — digit separators (`86_400`) do not split a fact (magic-constants
// compares raw lexemes; this gate does not).
//
// Never counted: strings shorter than --min-length (4), numbers with
// magnitude at or below --min-value (100 — 0, 1, 10, 100 happen
// everywhere), protocol positions (object keys, computed member indexes,
// switch case labels — the same rule as magic-constants), import/export
// source specifiers (the JS analog of upstream's directive URIs), and
// values listed in --ignore. `--ignore` entries containing `/` are
// file-path globs exempting whole files instead; --exclude GLOB drops
// files from the count (upstream's generated + test/** defaults are
// covered by the shared file selection, which already skips test paths).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { globToRegExp } from './bannedImports.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { childrenOf, isNode, parseSource } from './complexity.js';
import { isIdentifierPosition, literalValue } from './magicConstants.js';

const MIN_FILES = 3;
const MIN_LENGTH = 4;
const MIN_VALUE = 100;

// Import/export specifiers name a module — a structural reference, not a
// fact (upstream exempts import/export/part/part-of URIs).
const DIRECTIVE_SOURCES = {
  ImportDeclaration: 'source',
  ExportNamedDeclaration: 'source',
  ExportAllDeclaration: 'source',
};

function isDirectiveSource(node, parent) {
  const field = DIRECTIVE_SOURCES[parent?.type];
  return field !== undefined && parent[field] === node;
}

// `--ignore` partition: plain entries match literal values, entries with a
// `/` are file-path globs exempting the files themselves (upstream's
// IgnoreConfig.partition).
function partitionIgnore(entries) {
  const values = new Set();
  const globs = [];
  for (const e of entries) {
    if (e.includes('/')) globs.push(e);
    else values.add(e);
  }
  return { values, globs };
}

// Semantic comparison key, raw value, and message form of a literal node,
// or undefined for non-literals. Strings (plain template literals
// included) compare by value; numbers by numeric value so digit
// separators never split a fact. JS has no adjacent-string concatenation,
// so no merged-value handling is needed; interpolations are skipped.
function semanticLiteral(node) {
  const raw = literalValue(node);
  if (raw === undefined) return undefined;
  if (node.type === 'NumericLiteral') {
    return {
      key: `n:${node.value}`,
      numeric: true,
      value: String(node.value),
      display: String(node.value),
    };
  }
  return { key: `s:${raw}`, numeric: false, value: raw, display: quoted(raw) };
}

// String literals render quoted and truncated in messages.
function quoted(value) {
  return value.length > 40 ? `'${value.slice(0, 40)}…'` : `'${value}'`;
}

// One file's contribution: const-declaration registry entries plus literal
// hits. A `const` initializer contributes exactly one isConstDecl hit when
// it is a plain literal (the blessed form / regression anchor); non-plain
// initializers descend so nested literals count as ordinary hits.
function visit(node, parent, file, state) {
  if (!isNode(node)) return;
  if (node.type === 'VariableDeclaration' && node.kind === 'const') {
    collectConstDecls(node, file, state);
    return;
  }
  recordLiteral(node, parent, file, state);
  for (const child of childrenOf(node)) visit(child, node, file, state);
}

function collectConstDecls(node, file, state) {
  for (const d of node.declarations) {
    // Destructuring patterns (`const { retry = 3000 } = opts`) carry
    // default-value literals outside d.init — they are hardcoded
    // occurrences, not named constants; walk them as ordinary sites
    // (magic-constants counts them the same way).
    visit(d.id, node, file, state);
    if (!d.init) continue;
    const lit = semanticLiteral(d.init);
    if (!lit) {
      for (const child of childrenOf(d.init)) visit(child, d.init, file, state);
      continue;
    }
    state.registry.set(lit.key, [
      ...(state.registry.get(lit.key) ?? []),
      { name: d.id?.name ?? '', file, line: d.loc.start.line },
    ]);
    addHit(state, file, lit, d.loc.start.line, true);
  }
}

// Ordinary literal occurrences. Protocol positions (shared with
// magic-constants) and import/export specifiers are exempt.
function recordLiteral(node, parent, file, state) {
  if (isIdentifierPosition(node, parent) || isDirectiveSource(node, parent)) return;
  const lit = semanticLiteral(node);
  if (lit) addHit(state, file, lit, node.loc.start.line, false);
}

// One literal occurrence. Ordinary numeric hits respect the magnitude
// floor and ignore list; const-declaration numeric hits bypass both
// (upstream adds them unfiltered — a duplicate const declaration is a
// regression even at a small value). String hits of both kinds respect
// the length floor and the ignore list.
function addHit(state, file, lit, line, isConstDecl) {
  if (lit.numeric) {
    if (!isConstDecl && (Math.abs(Number(lit.value)) <= state.minValue || state.ignore.has(lit.value))) return;
  } else if (lit.value.length < state.minLength || state.ignore.has(lit.value)) {
    return;
  }
  const entry = state.literals.get(lit.key) ?? { key: lit.key, display: lit.display, sites: [] };
  entry.sites.push({ file, line, isConstDecl });
  state.literals.set(lit.key, entry);
}

/**
 * Scattered-constant violations across files.
 *
 * @param {string[]} files  absolute paths (the default selection already
 *   excludes test files — upstream's test/** exclude default).
 * @param {string} projectRoot
 * @param {{minFiles?: number, minLength?: number, minValue?: number,
 *   ignore?: string[], exclude?: string[]}} [opts]
 * @returns {{violations: Array<{file, line, message}>, checked: number,
 *   regressions: number}}
 */
export function scatteredConstantsViolations(files, projectRoot, opts = {}) {
  const { values: ignoreValues, globs: ignoreGlobs } = partitionIgnore(opts.ignore ?? []);
  const excluded = [...ignoreGlobs, ...(opts.exclude ?? [])].map(globToRegExp);
  const state = {
    minFiles: opts.minFiles ?? MIN_FILES,
    minLength: opts.minLength ?? MIN_LENGTH,
    minValue: opts.minValue ?? MIN_VALUE,
    ignore: ignoreValues,
    registry: new Map(),
    literals: new Map(),
  };
  let checked = 0;
  for (const file of files) {
    const rel = toRelPath(file, projectRoot);
    if (excluded.some((g) => g.test(rel))) continue;
    checked++;
    const ast = parseSource(readFileSync(file, UTF8), path.extname(file));
    visit(ast.program, null, rel, state);
  }
  const violations = [];
  let regressions = 0;
  for (const lit of state.literals.values()) {
    const found = violationsFor(lit, state.registry, state.minFiles);
    violations.push(...found.violations);
    regressions += found.regressions;
  }
  return { violations, checked, regressions };
}

// Violations for one literal value: constant regressions first (any
// occurrence count — the winning declaration's own site is exempt),
// scattered sites when no constant exists and the distinct-file count
// reached the threshold.
function violationsFor(lit, registry, minFiles) {
  const shared = registry.get(lit.key)?.[0];
  if (shared) {
    const violations = lit.sites
      .filter((s) => !(s.isConstDecl && s.file === shared.file && s.line === shared.line))
      .map((s) => ({
        file: s.file,
        line: s.line,
        message: `hardcoded ${lit.display} duplicates constant \`${shared.name}\` (${shared.file}:${shared.line}) — reference the constant instead of repeating the literal`,
      }));
    return { violations, regressions: violations.length };
  }
  const nFiles = new Set(lit.sites.map((s) => s.file)).size;
  if (nFiles < minFiles) return { violations: [], regressions: 0 };
  const scope = `${nFiles} files (${lit.sites.length} occurrences)`;
  return {
    violations: lit.sites.map((s) => ({
      file: s.file,
      line: s.line,
      message: `literal ${lit.display} repeats in ${scope} — extract a shared constant and reference it from every site; verify all occurrences mean the same thing first`,
    })),
    regressions: 0,
  };
}

/**
 * One-line summary mirroring the Dart gate: `N files scanned, no literals
 * repeat across files`, or the per-kind counts.
 */
export function scatteredConstantsSummary({ violations, checked, regressions = 0 }) {
  return violations === 0
    ? `${checked} files scanned, no literals repeat across files`
    : `${regressions} hardcoded re-uses of existing constants, ${violations - regressions} scattered-literal occurrences`;
}

/**
 * Parse `scattered-constants` arguments into `{ minFiles, minLength,
 * minValue, ignore, exclude, paths }`. `--flag VALUE` and `--flag=VALUE`
 * both accepted; `--ignore` and `--exclude` are repeatable; unknown flags
 * and invalid numbers are usage errors.
 *
 * @param {string[]} argv
 */
export function parseScatteredConstantsArgs(argv) {
  const opts = {
    minFiles: MIN_FILES,
    minLength: MIN_LENGTH,
    minValue: MIN_VALUE,
    ignore: [],
    exclude: [],
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(
      opts,
      argv[i],
      argv,
      i,
      {
        '--min-files': 'minFiles',
        '--min-length': 'minLength',
        '--min-value': 'minValue',
        '--ignore': 'ignore',
        '--exclude': 'exclude',
      },
      new Set(['--min-files', '--min-length', '--min-value']),
    );
  }
  return opts;
}

/**
 * The `scattered-constants` command body. Returns exit code 2 iff
 * violations exist.
 */
export function runScatteredConstants(argv, ctx) {
  const opts = parseScatteredConstantsArgs(argv);
  return runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    (fs, root) => scatteredConstantsViolations(fs, root, opts),
    scatteredConstantsSummary,
  );
}
