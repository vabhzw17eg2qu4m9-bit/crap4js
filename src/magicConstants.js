// `magic-constants` subcommand: flags magic literals — hex color values
// (`0xRRGGBB` / `0xAARRGGBB`) used outside named constant declarations,
// and numeric or string literals whose value repeats 3+ times in one
// file (every occurrence is reported). Port of crap4dart's
// magic_constants gate (0.6.x) with the upstream defaults baked in
// (min_duplicates=3, min_length=4, hex rule on); crap4js has no config.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gateFiles, toRelPath } from './files.js';
import { runCheck } from './gateCommon.js';
import { childrenOf, isNode, parseSource } from './complexity.js';

const MIN_DUPLICATES = 3;
const MIN_LENGTH = 4;
const HEX_COLOR = /^0[xX][0-9a-fA-F]{6,8}$/;

/**
 * Magic-constant violations across files.
 *
 * @param {string[]} files  absolute paths (non-test sources).
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function magicConstantsViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    checked++;
    const ast = parseSource(readFileSync(file, 'utf8'), path.extname(file));
    violations.push(...fileViolations(ast.program, toRelPath(file, projectRoot)));
  }
  return { violations, checked };
}

// One file, in upstream order: hex colors outside constant initializers,
// then every occurrence of a literal repeated MIN_DUPLICATES+ times.
function fileViolations(program, file) {
  const found = collectLiterals(program);
  const violations = found.hexColors
    .filter((o) => !found.constLines.has(o.line))
    .map((o) => ({ file, line: o.line, message: 'hex color outside a constant declaration' }));
  for (const [value, occurrences] of found.counts) {
    if (occurrences.length >= MIN_DUPLICATES) {
      violations.push(...repeatViolations(file, value, occurrences));
    }
  }
  return violations;
}

function repeatViolations(file, value, occurrences) {
  return occurrences.map((o) => ({
    file,
    line: o.line,
    message: `literal ${value} repeats ${occurrences.length} times — extract a named constant`,
  }));
}

// One walk per file: hex-color occurrences, per-value literal counts, and
// the lines belonging to `const` initializers.
function collectLiterals(program) {
  const state = { hexColors: [], counts: new Map(), constLines: new Set() };
  visit(program, state);
  return state;
}

function visit(node, state) {
  if (!isNode(node)) return;
  if (node.type === 'VariableDeclaration' && node.kind === 'const') {
    for (const d of node.declarations) {
      if (d.init) markLines(d.init, state.constLines);
    }
  }
  record(node, state);
  for (const child of childrenOf(node)) visit(child, state);
}

// The repeat-counting value of a literal node, or undefined for
// non-literals. Numbers count by raw lexeme, strings by value; template
// literals with interpolations are skipped entirely (JS has no adjacent-
// string concatenation, so no merged-value handling is needed).
function literalValue(node) {
  // Babel keeps the raw lexeme in `extra.raw`.
  if (node.type === 'NumericLiteral') return node.extra?.raw ?? String(node.value);
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked;
  }
  return undefined;
}

function record(node, state) {
  const value = literalValue(node);
  if (value === undefined || value.length < MIN_LENGTH) return;
  const line = node.loc.start.line;
  if (node.type === 'NumericLiteral' && HEX_COLOR.test(value)) {
    state.hexColors.push({ line });
  }
  const occurrences = state.counts.get(value) ?? [];
  occurrences.push({ line });
  state.counts.set(value, occurrences);
}

// Every line a node spans — a hex color anywhere inside a const
// initializer (call arguments included) sits on an exempt line.
function markLines(node, lines) {
  for (let l = node.loc.start.line; l <= node.loc.end.line; l++) lines.add(l);
}

/**
 * One-line summary mirroring the Dart gate: `M files free of magic
 * constants`, or `N magic constant(s) in M files`.
 */
export function magicConstantsSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} files free of magic constants`
    : `${violations} magic constant(s) in ${checked} files`;
}

/**
 * The `magic-constants` command body. Takes only paths — any `--flag`
 * argument is a usage error that throws and surfaces as exit code 1.
 * Returns exit code 2 iff violations exist.
 */
export function runMagicConstants(argv, ctx) {
  const flag = argv.find((a) => a.startsWith('--'));
  if (flag) throw new Error(`unknown flag: ${flag}`);
  return runCheck(
    ctx,
    gateFiles(argv, ctx.cwd),
    magicConstantsViolations,
    magicConstantsSummary,
  );
}
