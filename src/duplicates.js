// `duplicates` subcommand: token-based duplicate-code detection. Port of
// crap4dart's duplication gate (spec §11.11) including the per-gate
// `sources` union (commit dc64e9c): every scanned file is tokenized
// (comments skipped, raw lexemes kept) and windows of `--min-tokens`
// tokens spanning at least `--min-lines` source lines are indexed; a
// window appearing twice or more - within or across files - grows a
// clone group extended to the maximal extent its occurrences share.
// Accepted groups are non-overlapping, longest first (PMD CPD Match
// semantics). `--report percentage` (the default) fails a file when its
// distinct duplicated lines exceed `--threshold` percent of its total
// lines; `--report clones` fails once per accepted clone group with all
// occurrence locations in the message.
//
// Opt-in normalizations extend detection beyond exact copy-paste:
// `--ignore-locals` consistently renames function-local identifiers to
// first-use-order placeholders, `--ignore-literals` masks string and
// numeric literals, `--ignore-identifiers` collapses every identifier to
// one placeholder (CPD --ignore-identifiers, structure-only matching),
// and `--ignore-imports` drops import/export directives and require()
// calls from tokenization. `--skip-duplicate-files` analyzes a
// token-identical file once. Detection unions the raw pass and the masked
// pass (upstream 94299e0), so enabling `--ignore-locals` can only add
// findings - exact copies are never lost to shifted placeholder numbering.
//
// ponytail: windows are indexed by their joined code string (NUL-
// separated, a byte no code contains), not upstream's Rabin-Karp hash -
// same windows, and a bucket key IS the exact window, so upstream's new
// collision-verification pass is unnecessary by construction. Rolling
// hashes would pay off only if scan time on very large files ever hurt.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expandPaths, gateFiles, isAnySourceFile, isTestPath, toRelPath } from './files.js';
import { globToRegExp } from './bannedImports.js';
import { parseTokenized, SKIP_KEYS, tokenizeSource } from './complexity.js';
import { applyGateArg, runCheck } from './gateCommon.js';

const DEFAULT_THRESHOLD = 1;
const TYPE_STRING = 'string';
const DEFAULT_MIN_TOKENS = 50;
const DEFAULT_MIN_LINES = 5;

const VALUE_FLAGS = {
  '--threshold': 'threshold',
  '--min-tokens': 'minTokens',
  '--min-lines': 'minLines',
  '--report': 'report',
  '--exclude': 'exclude',
  '--source': 'source',
};
const NUMBER_FLAGS = new Set(['--threshold', '--min-tokens', '--min-lines']);
// Violation styles (upstream `report: percentage|clones`): percentage is
// the default, clones is the PMD CPD style - one violation per group.
const REPORT_MODES = new Set(['percentage', 'clones']);
// The normalization knobs (upstream flat YAML keys under the duplication
// gate): bare kebab-case flags, opt-in, so absent means false.
const BOOLEAN_FLAGS = {
  '--ignore-locals': 'ignoreLocals',
  '--ignore-literals': 'ignoreLiterals',
  '--ignore-identifiers': 'ignoreIdentifiers',
  '--ignore-imports': 'ignoreImports',
  '--skip-duplicate-files': 'skipDuplicateFiles',
};

/**
 * Parse `duplicates` arguments into `{ threshold, minTokens, minLines,
 * report, exclude, source, paths }`. Value flags may be written
 * `--flag VALUE` or `--flag=VALUE`; `--exclude` and `--source` are
 * repeatable. `--report` accepts `percentage` (the default) or `clones`.
 * The boolean normalization flags are bare (`--ignore-locals`, ...) and
 * appear in the result only when passed — absence is their `false`.
 *
 * @param {string[]} argv
 */
export function parseDuplicateArgs(argv) {
  const opts = {
    threshold: DEFAULT_THRESHOLD,
    minTokens: DEFAULT_MIN_TOKENS,
    minLines: DEFAULT_MIN_LINES,
    report: 'percentage',
    exclude: [],
    source: [],
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const bool = BOOLEAN_FLAGS[argv[i]];
    if (bool) opts[bool] = true;
    else i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  if (!REPORT_MODES.has(opts.report)) {
    throw new Error(`Invalid --report: ${opts.report}`);
  }
  return opts;
}

/**
 * The `duplicates` command body. Returns exit code 2 iff any file's
 * duplicated-line percent exceeds the threshold.
 */
export function runDuplicates(argv, ctx) {
  const opts = parseDuplicateArgs(argv);
  const files = scanSet(opts, ctx.cwd);
  return runCheck(
    ctx,
    files,
    (fs, root) => duplicatesViolations(fs, root, opts),
    (result) => duplicatesSummary(result, opts),
  );
}

// The duplication scan set: the standard gate selection (explicit paths or
// the src/ walk) unioned with every --source path — files with a source
// extension taken directly, directories walked recursively, missing paths
// skipped silently (commit dc64e9c). Test files and test directories (the
// port's standard exclusion, upstream's default test glob) and --exclude
// globs — matched against project-relative POSIX paths — are filtered from
// the union; the result is sorted for deterministic scans.
function scanSet(opts, projectRoot) {
  const files = new Set(gateFiles(opts.paths, projectRoot));
  for (const f of expandPaths(opts.source, projectRoot, isAnySourceFile)) {
    files.add(f);
  }
  const globs = opts.exclude.map(globToRegExp);
  return [...files]
    .filter(
      (f) =>
        !isTestPath(f) &&
        !globs.some((g) => g.test(toRelPath(f, projectRoot))),
    )
    .sort();
}

/**
 * Duplicate detection over a file set: tokenize, accept non-overlapping
 * clone groups longest first, then build violations — per-file percentage
 * (default) or one per clone group (`report: 'clones'`). Files with fewer
 * than `minTokens` tokens are skipped from the scan entirely (upstream
 * behavior), so `checked` counts only tokenized files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {{threshold: number, minTokens: number, minLines: number,
 *   report?: string, ignoreLocals?: boolean, ignoreLiterals?: boolean,
 *   ignoreIdentifiers?: boolean, ignoreImports?: boolean,
 *   skipDuplicateFiles?: boolean}} opts
 * @returns {{violations: Array<{file, line, message}>, checked: number,
 *            checkedLines?: number, dupLines?: number,
 *            totalPercent?: string}}
 */
export function duplicatesViolations(files, projectRoot, opts) {
  const bags = tokenizeFiles(files, projectRoot, opts);
  const groups = acceptGroups(bags, detectClones(bags, opts));
  if (opts.report === 'clones') return clonesResult(bags, groups);
  const violations = [];
  let checkedLines = 0;
  let dupLines = 0;
  for (const bag of bags) {
    const dup = duplicatedLines(bag);
    checkedLines += bag.totalLines;
    dupLines += dup.size;
    const violation = violationFor(bag, dup, opts.threshold);
    if (violation) violations.push(violation);
  }
  return { violations, checked: bags.length, checkedLines, dupLines };
}

// Reads and tokenizes each scanned file. Tokens are `{ value, line }` pairs
// (plus `lexeme` when a normalization mode is active) and a `dup` marker
// added during detection; `totalLines` uses the upstream line count
// (newlines, +1 for a trailing fragment, 0 when empty).
//
// Any normalization knob routes through normalizedTokens: masked values
// for hashing, the AST for import ranges and scopes. skip_duplicate_files
// compares masked values too, so a file differing only in comments from an
// earlier one is skipped as well (upstream compares the same streams).
// The minTokens floor applies before the dedup, exactly like upstream.
const MASKING_KEYS = [
  'ignoreLocals',
  'ignoreLiterals',
  'ignoreIdentifiers',
  'ignoreImports',
  'skipDuplicateFiles',
];

function tokenizeFiles(files, projectRoot, opts) {
  const masked = MASKING_KEYS.some((key) => opts[key]);
  const bags = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const ext = path.extname(file);
    const tokens = masked
      ? normalizedTokens(source, ext, opts)
      : tokenizeSource(source, ext);
    if (tokens.length < opts.minTokens) continue;
    if (isCopiedStream(bags, tokens, opts)) continue;
    bags.push({
      rel: toRelPath(file, projectRoot),
      tokens,
      totalLines: lineCount(source),
    });
  }
  return bags;
}

// CPD --skip-duplicate-files: whether a file whose token stream equals an
// earlier file's is dropped - a copied file is analyzed once, reported as
// one clone group, not as N x N pairs.
function isCopiedStream(bags, tokens, opts) {
  return Boolean(opts.skipDuplicateFiles) &&
    bags.some((bag) => sameTokens(bag.tokens, tokens));
}

// Whether two token streams are identical by (masked) value.
function sameTokens(a, b) {
  return a.length === b.length && a.every((t, i) => t.value === b[i].value);
}

// ---------------------------------------------------------------------------
// Type-2 normalization (upstream 0599df2 + 94299e0). Both knobs are opt-in;
// with both off the scan tokenizes exactly as before.

// Babel's token labels for template-literal text chunks (leading and final
// — the embedded expressions between them are ordinary name tokens).
const TEMPLATE_TEXT_LABELS = new Set(['...${', '...`']);

// Node types owning an outermost function-local scope: one per method,
// constructor, or (arrow) function; nested functions share the outermost
// scope — upstream's depth guard, no inner-scope shadow tracking.
const SCOPE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'ClassPrivateMethod',
  'ObjectMethod',
]);

// Nodes carrying parameters (superset of SCOPE_TYPES) and type parameters.
const FUNCTION_TYPES = new Set([...SCOPE_TYPES]);
const TYPE_PARAM_TYPES = new Set(['TSTypeParameter', 'TypeParameter']);

// Child AST nodes of `node`: the object- or array-valued properties whose
// values are nodes, skipping the meta keys babel attaches alongside the
// tree (same exclusions as the complexity walker).
function isNode(value) {
  return value && typeof value.type === TYPE_STRING;
}

function childNodes(node) {
  const children = [];
  for (const key in node) {
    if (SKIP_KEYS.has(key) || key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) children.push(child);
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

// Object-pattern bindings; rest properties bind their argument.
function bindObjectPattern(node, names) {
  for (const prop of node.properties) {
    bindings(prop.type === 'RestElement' ? prop.argument : prop.value, names);
  }
}

// Names bound by a parameter or pattern node: plain identifiers, defaults,
// rest elements, and array/object destructuring. TS parameter properties
// (`constructor(private x)`) reference API state — never renamed.
function bindings(node, names) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      names.add(node.name);
      break;
    case 'AssignmentPattern':
      bindings(node.left, names);
      break;
    case 'RestElement':
      bindings(node.argument, names);
      break;
    case 'ArrayPattern':
      for (const element of node.elements) bindings(element, names);
      break;
    case 'ObjectPattern':
      bindObjectPattern(node, names);
      break;
  }
}

// A type parameter's plain name, whether babel models it as a string
// (`TypeParameter`) or an identifier node (`TSTypeParameter`).
function addTypeParam(node, names) {
  const name = node.name?.name ?? node.name;
  if (typeof name === TYPE_STRING) names.add(name);
}

// Parameter bindings for every function-flavoured node. The scope's own
// name is API surface and stays unrenamed (root skipped, nested collected).
function collectFunctionLocals(node, root, names) {
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
    if (node !== root && node.id) names.add(node.id.name);
  }
  for (const param of node.params) bindings(param, names);
}

// Identifiers declared directly by one node of a function's subtree:
// parameters, local variables, loop variables, catch parameters, type
// parameters, locally declared functions, destructuring bindings. Flat on
// purpose (upstream keeps no inner-scope shadow tracking).
function collectScopeNames(node, root, names) {
  if (FUNCTION_TYPES.has(node.type)) return collectFunctionLocals(node, root, names);
  if (node.type === 'VariableDeclarator') return bindings(node.id, names);
  if (node.type === 'CatchClause') return bindings(node.param, names);
  if (TYPE_PARAM_TYPES.has(node.type)) addTypeParam(node, names);
}

// Every identifier declared anywhere inside a function's subtree.
function scopeNames(root) {
  const names = new Set();
  const walk = (node) => {
    collectScopeNames(node, root, names);
    for (const child of childNodes(node)) walk(child);
  };
  walk(root);
  return names;
}

// The outermost function scopes of a program, sorted and disjoint so token
// lookup can binary-search.
function buildScopes(program) {
  const scopes = [];
  const walk = (node) => {
    if (SCOPE_TYPES.has(node.type)) {
      const placeholders = new Map();
      scopes.push({
        start: (node.params[0] ?? node.body).start,
        end: node.end,
        names: scopeNames(node),
        // Placeholder in first-use order: renamed clones of the same
        // algorithm hash identically, while locals swapped against each
        // other keep different placeholders and never match.
        placeholderFor(name) {
          let placeholder = placeholders.get(name);
          if (!placeholder) {
            placeholder = `$L${placeholders.size + 1}`;
            placeholders.set(name, placeholder);
          }
          return placeholder;
        },
      });
      return; // the whole subtree shares this outermost scope
    }
    for (const child of childNodes(node)) walk(child);
  };
  walk(program);
  scopes.sort((a, b) => a.start - b.start);
  return scopes;
}

// The scope containing offset, or null — binary search over starts.
function scopeAt(scopes, offset) {
  let low = 0;
  let high = scopes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const scope = scopes[mid];
    if (offset < scope.start) high = mid - 1;
    else if (offset >= scope.end) low = mid + 1;
    else return scope;
  }
  return null;
}

// Placeholder for a masked literal token, or undefined to keep the lexeme.
function literalPlaceholder(token) {
  const label = token.type.label;
  if (label === 'string' || TEMPLATE_TEXT_LABELS.has(label)) return '$STR';
  if (label === 'num' || label === 'bigint') return '$NUM';
  return undefined;
}

// babel token labels that are identifier-shaped for --ignore-identifiers.
const IDENTIFIER_LABELS = new Set(['name', 'privateName']);

// Masked value of one token: literal erasure first, then identifier
// erasure (CPD --ignore-identifiers, structure-only matching), then
// consistent local renaming. babel's `name` label covers plain
// identifiers AND contextual keywords (async, of, from, as, get, ...) —
// the JS analog of upstream's built-in/pseudo keyword slots — and
// `privateName` the #-prefixed ones; real keywords keep their lexeme.
function tokenValue(token, lexeme, opts, scopes) {
  if (opts.ignoreLiterals) {
    const placeholder = literalPlaceholder(token);
    if (placeholder) return placeholder;
  }
  if (opts.ignoreIdentifiers && IDENTIFIER_LABELS.has(token.type.label)) {
    return '$ID';
  }
  if (scopes.length > 0 && token.type.label === 'name') {
    const scope = scopeAt(scopes, token.start);
    if (scope?.names.has(lexeme)) return scope.placeholderFor(lexeme);
  }
  return lexeme;
}

// Normalized token stream for the masked modes: raw lexeme plus masked
// value (identical when no masking applies), comments and EOF skipped,
// and --ignore-imports ranges dropped. Template text chunks are already
// opaque constants in babel's stream and the identifiers they interpolate
// are renamed by the scope machinery, so unlike upstream (a single
// STRING_INTERPOLATION token) no $STR masking is needed under
// ignore_locals alone.
function normalizedTokens(source, ext, opts) {
  const { tokens, program } = parseTokenized(source, ext);
  const scopes = opts.ignoreLocals ? buildScopes(program) : [];
  const ranges = opts.ignoreImports ? importSkipRanges(program) : [];
  const normalized = [];
  for (const token of tokens) {
    if (token.type.label === 'eof' || typeof token.type === TYPE_STRING) continue;
    if (inRanges(ranges, token.start)) continue;
    const lexeme = source.slice(token.start, token.end);
    normalized.push({
      lexeme,
      value: tokenValue(token, lexeme, opts, scopes),
      line: token.loc.start.line,
    });
  }
  return normalized;
}

// Token [start, end) ranges excluded under --ignore-imports: import/export
// directives — the JS analog of upstream's import/export/part — plus
// CommonJS require() calls (a CJS import). `export` wrapping real code
// keeps the code: only the `export`/`export default` keywords and a
// trailing `from '...'` clause of a re-export drop out; a brace-less
// `export { a, b } [from '...']` is directive boilerplate throughout.
function importSkipRanges(program) {
  const ranges = [];
  const walk = (node) => {
    if (DIRECTIVE_TYPES.has(node.type)) {
      ranges.push([node.start, node.end]);
      return;
    }
    if (node.type === 'ExportNamedDeclaration') {
      // babel never attaches `source` when `declaration` is present (the
      // two are mutually exclusive), so a wrapping export has no trailing
      // from-clause to drop.
      if (!node.declaration) {
        ranges.push([node.start, node.end]);
        return;
      }
      ranges.push([node.start, node.declaration.start]);
    } else if (node.type === 'ExportDefaultDeclaration') {
      ranges.push([node.start, node.declaration.start]);
    } else if (isRequireCall(node)) {
      ranges.push([node.start, node.end]);
      return;
    }
    for (const child of childNodes(node)) walk(child);
  };
  walk(program);
  return ranges;
}

// Pure directive statements (no wrapped code).
const DIRECTIVE_TYPES = new Set(['ImportDeclaration', 'ExportAllDeclaration']);

// Whether node is a CommonJS `require(...)` call.
function isRequireCall(node) {
  return node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require';
}

// Whether offset falls inside any [start, end) range (few ranges, linear).
function inRanges(ranges, offset) {
  return ranges.some(([s, e]) => offset >= s && offset < e);
}

// Upstream line count: newline count, +1 for a trailing fragment. Only
// called on files with >= minTokens tokens, so source is never empty.
function lineCount(source) {
  const newlines = source.split('\n').length - 1;
  return source.endsWith('\n') ? newlines : newlines + 1;
}

// The duplication engine (upstream CPD-parity rework). Each pass indexes
// every valid window by its joined code string and turns every bucket of
// two or more positions into a candidate group whose occurrences extend
// to the maximal extent they share (the longest common run around the
// minTokens window). Candidates from both passes then compete in one
// greedy selection; acceptGroups marks the tokens of the winners. Two
// passes when local renaming is active (upstream 94299e0): raw lexemes
// (Type-1) alongside the masked values (Type-2) — placeholder numbering
// is first-use-per-scope, so the masked pass alone could miss exact
// copies whose enclosing scopes shift the numbering.
function detectClones(bags, opts) {
  const candidates = [];
  if (opts.ignoreLocals) {
    candidates.push(...collectGroups(bags, opts, (t) => t.lexeme));
  }
  candidates.push(...collectGroups(bags, opts, (t) => t.value));
  // Longest clones first, then most occurrences, then position — the
  // selection order that keeps reporting deterministic.
  candidates.sort(byPriority);
  return candidates;
}

// One detection pass: index windows, build candidate groups.
function collectGroups(bags, opts, codeOf) {
  const { minTokens, minLines } = opts;
  const occurrences = new Map();
  const codes = bags.map((bag) => bag.tokens.map(codeOf));
  for (let b = 0; b < bags.length; b++) {
    indexWindows(bags[b].tokens, b, minTokens, minLines, occurrences, codes[b]);
  }
  const groups = [];
  for (const positions of occurrences.values()) {
    if (positions.length >= 2) {
      const group = groupFromBucket(bags, positions, codes, minTokens, minLines);
      if (group) groups.push(group);
    }
  }
  return groups;
}

// Sliding windows of minTokens codes; a window is recorded only when it
// spans at least minLines source lines (first to last token).
function indexWindows(tokens, bagIndex, minTokens, minLines, occurrences, codes) {
  for (let start = 0; start + minTokens <= tokens.length; start++) {
    if (tokens[start + minTokens - 1].line - tokens[start].line + 1 < minLines) {
      continue;
    }
    const key = codes.slice(start, start + minTokens).join('\u0000');
    const positions = occurrences.get(key);
    if (positions) positions.push([bagIndex, start]);
    else occurrences.set(key, [[bagIndex, start]]);
  }
}

// One candidate group from a bucket: [bagIndex, start, end) per occurrence.
// Every position's window is extended against the first position's (the
// reference) to the extent they share, then clipped to the common token
// count; the reference is anchored at its own window and clipped to the
// same length — it must not extend against itself, or it would grow over
// the whole file. Dropped when the common span holds fewer than minLines
// lines. Bucket keys are exact windows (string equality), so upstream's
// collision re-verification has no JS counterpart.
function groupFromBucket(bags, positions, codes, minTokens, minLines) {
  const [refBag, refStart] = positions[0];
  const refCodes = codes[refBag];
  const extents = positions.map(([b, start]) =>
    extentOf(codes[b], start, refCodes, refStart, minTokens));
  let commonLen = minTokens;
  for (let i = 1; i < extents.length; i++) {
    commonLen = Math.min(commonLen, extents[i][1] - extents[i][0]);
  }
  const refTokens = bags[refBag].tokens;
  const lineSpan =
    refTokens[refStart + commonLen - 1].line - refTokens[refStart].line + 1;
  if (lineSpan < minLines) return null;
  return positions.map(([b, start], i) => {
    const s = i === 0 ? refStart : extents[i][0];
    return [b, s, s + commonLen];
  });
}

// The reporting order: longest clones first, then most occurrences, then
// first position.
function byPriority(a, b) {
  const len = (g) => g[0][2] - g[0][1];
  if (len(b) !== len(a)) return len(b) - len(a);
  if (b.length !== a.length) return b.length - a.length;
  return a[0][0] - b[0][0] || a[0][1] - b[0][1];
}

// Greedily accepts non-overlapping groups — PMD CPD Match semantics — and
// marks their tokens duplicated; a group whose ANY occurrence overlaps an
// already accepted range is dropped whole.
function acceptGroups(bags, candidates) {
  const accepted = [];
  const taken = new Map();
  for (const group of candidates) {
    if (group.some(([b, s, e]) => overlaps(taken.get(b), s, e))) continue;
    for (const [b, s, e] of group) {
      if (!taken.has(b)) taken.set(b, []);
      taken.get(b).push([s, e]);
      const tokens = bags[b].tokens;
      for (let i = s; i < e; i++) tokens[i].dup = true;
    }
    accepted.push(group);
  }
  return accepted;
}

// Whether [start]..[end) overlaps any accepted range of one file.
function overlaps(ranges, start, end) {
  return (ranges ?? []).some(([s, e]) => start < e && s < end);
}

// Maximal extent of the window at curStart shared with the reference at
// refStart: grown left and right while the surrounding codes match.
function extentOf(cur, curStart, ref, refStart, minTokens) {
  let start = curStart;
  let refS = refStart;
  while (start > 0 && refS > 0 && cur[start - 1] === ref[refS - 1]) {
    start--;
    refS--;
  }
  let end = curStart + minTokens;
  let refE = refStart + minTokens;
  while (end < cur.length && refE < ref.length && cur[end] === ref[refE]) {
    end++;
    refE++;
  }
  return [start, end];
}

// One violation per accepted clone group, every occurrence location in
// the message (PMD CPD style); at most three locations inline.
function clonesResult(bags, groups) {
  const violations = groups.map((group) => {
    const [refBag, refStart, refEnd] = group[0];
    const locations = group.map(([b, s, e]) =>
      `${bags[b].rel}:${bags[b].tokens[s].line}-${bags[b].tokens[e - 1].line}`);
    const shown = locations.slice(0, 3).join('; ');
    const more = locations.length > 3 ? ` (+${locations.length - 3} more)` : '';
    const tokens = bags[refBag].tokens;
    const lineSpan = tokens[refEnd - 1].line - tokens[refStart].line + 1;
    return {
      file: bags[refBag].rel,
      line: tokens[refStart].line,
      message: `clone: ${refEnd - refStart} tokens / ${lineSpan} lines, ` +
        `${locations.length} occurrences: ${shown}${more}`,
    };
  });
  return { violations, checked: bags.length, totalPercent: totalPercent(bags) };
}

// The project-wide duplicated-line percentage over the scanned bags
// (marked tokens' distinct lines vs total lines, 'NN.NN') — so a
// clones-mode summary always carries a number too (upstream 0f54f0d).
function totalPercent(bags) {
  let checkedLines = 0;
  let dupLines = 0;
  for (const bag of bags) {
    checkedLines += bag.totalLines;
    dupLines += duplicatedLines(bag).size;
  }
  return checkedLines === 0 ? '0.00' : ((dupLines / checkedLines) * 100).toFixed(2);
}

function duplicatedLines(bag) {
  const lines = new Set();
  for (const t of bag.tokens) {
    if (t.dup) lines.add(t.line);
  }
  return lines;
}

// A violation when the file's distinct duplicated lines exceed threshold
// percent of its lines; the first duplicated line is the set's head (the
// set is built in token order, so its lines ascend).
function violationFor(bag, dupLines, threshold) {
  const percent = (dupLines.size / bag.totalLines) * 100;
  if (percent <= threshold) return null;
  return {
    file: bag.rel,
    line: dupLines.values().next().value,
    message: `${percent.toFixed(2)}% duplicated lines > ${threshold}%`,
  };
}

// One-line summaries mirroring the Dart gate: percentage mode reports the
// tokenized file count and overall duplicated-line percent on pass, the
// over-threshold file count on fail; clones mode counts accepted groups
// and carries the project-wide duplicated-line percent (upstream 0f54f0d).
function duplicatesSummary({ violations, checked, checkedLines, dupLines, totalPercent }, opts) {
  if (opts.report === 'clones') {
    const tail = `, ${totalPercent}% duplicated lines`;
    return violations > 0
      ? `${violations} clone groups (>= ${opts.minTokens} tokens, >= ${opts.minLines} lines)${tail}`
      : `no clones >= ${opts.minLines} lines across ${checked} files${tail}`;
  }
  if (violations > 0) {
    return `${violations}/${checked} files over ${opts.threshold}% duplication`;
  }
  const percent = checkedLines === 0 ? 0.0 : (dupLines / checkedLines) * 100;
  return `${checked} files, ${percent.toFixed(2)}% duplicated lines`;
}
