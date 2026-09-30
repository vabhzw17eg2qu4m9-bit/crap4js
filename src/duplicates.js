// `duplicates` subcommand: token-based duplicate-code detection. Port of
// crap4dart's duplication gate (spec §11.11) including the per-gate
// `sources` union (commit dc64e9c): every scanned file is tokenized
// (comments skipped, raw lexemes kept), and any sliding window of
// `--min-tokens` tokens spanning at least `--min-lines` source lines that
// appears twice or more - within or across files - marks its tokens as
// duplicated. A file violates when its distinct duplicated lines exceed
// `--threshold` percent of its total lines.
//
// Two opt-in normalizations (upstream 0599df2) extend detection to renamed
// clones: `--ignore-locals` consistently renames function-local identifiers
// to first-use-order placeholders, `--ignore-literals` masks string and
// numeric literals. Detection is a union of the raw pass and the masked
// pass (upstream 94299e0), so enabling `--ignore-locals` can only add
// findings — exact copies are never lost to shifted placeholder numbering.
//
// ponytail: windows are indexed by their joined lexeme string (NUL-
// separated, a byte no lexeme contains), not upstream's Rabin-Karp hash -
// same windows, no collision handling; switch to rolling hashes only if
// scan time on very large files ever matters.

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
  '--exclude': 'exclude',
  '--source': 'source',
};
const NUMBER_FLAGS = new Set(['--threshold', '--min-tokens', '--min-lines']);
// The Type-2 normalization knobs (upstream `ignore_locals`/`ignore_literals`
// YAML keys): bare kebab-case flags, opt-in, so absent means false.
const BOOLEAN_FLAGS = {
  '--ignore-locals': 'ignoreLocals',
  '--ignore-literals': 'ignoreLiterals',
};

/**
 * Parse `duplicates` arguments into `{ threshold, minTokens, minLines,
 * exclude, source, paths }`. Value flags may be written `--flag VALUE` or
 * `--flag=VALUE`; `--exclude` and `--source` are repeatable. The boolean
 * normalization flags are bare (`--ignore-locals`, `--ignore-literals`)
 * and appear in the result only when passed — absence is their `false`.
 *
 * @param {string[]} argv
 */
export function parseDuplicateArgs(argv) {
  const opts = {
    threshold: DEFAULT_THRESHOLD,
    minTokens: DEFAULT_MIN_TOKENS,
    minLines: DEFAULT_MIN_LINES,
    exclude: [],
    source: [],
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const bool = BOOLEAN_FLAGS[argv[i]];
    if (bool) opts[bool] = true;
    else i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
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
 * Duplicate detection over a file set: tokenize, mark duplicated windows,
 * and build per-file violations. Files with fewer than `minTokens` tokens
 * are skipped from the scan entirely (upstream behavior), so `checked`
 * counts only tokenized files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {{threshold: number, minTokens: number, minLines: number,
 *   ignoreLocals?: boolean, ignoreLiterals?: boolean}} opts
 * @returns {{violations: Array<{file, line, message}>, checked: number,
 *            checkedLines: number, dupLines: number}}
 */
export function duplicatesViolations(files, projectRoot, opts) {
  const bags = tokenizeFiles(files, projectRoot, opts);
  markDuplicates(bags, opts.minTokens, opts.minLines, opts.ignoreLocals);
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
function tokenizeFiles(files, projectRoot, opts) {
  const masked = opts.ignoreLocals || opts.ignoreLiterals;
  const bags = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const ext = path.extname(file);
    const tokens = masked
      ? normalizedTokens(source, ext, opts)
      : tokenizeSource(source, ext);
    if (tokens.length >= opts.minTokens) {
      bags.push({
        rel: toRelPath(file, projectRoot),
        tokens,
        totalLines: lineCount(source),
      });
    }
  }
  return bags;
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

// Masked value of one token: literal erasure first, then consistent local
// renaming (API surface — names outside the scope's declared set — keeps
// its lexeme).
function tokenValue(token, lexeme, opts, scopes) {
  if (opts.ignoreLiterals) {
    const placeholder = literalPlaceholder(token);
    if (placeholder) return placeholder;
  }
  if (scopes.length > 0 && token.type.label === 'name') {
    const scope = scopeAt(scopes, token.start);
    if (scope?.names.has(lexeme)) return scope.placeholderFor(lexeme);
  }
  return lexeme;
}

// Normalized token stream for the masked modes: raw lexeme plus masked
// value (identical when no masking applies), comments and EOF skipped.
// Template text chunks are already opaque constants in babel's stream and
// the identifiers they interpolate are renamed by the scope machinery, so
// unlike upstream (a single STRING_INTERPOLATION token) no $STR masking is
// needed under ignore_locals alone.
function normalizedTokens(source, ext, opts) {
  const { tokens, program } = parseTokenized(source, ext);
  const scopes = opts.ignoreLocals ? buildScopes(program) : [];
  const normalized = [];
  for (const token of tokens) {
    if (token.type.label === 'eof' || typeof token.type === TYPE_STRING) continue;
    const lexeme = source.slice(token.start, token.end);
    normalized.push({
      lexeme,
      value: tokenValue(token, lexeme, opts, scopes),
      line: token.loc.start.line,
    });
  }
  return normalized;
}

// Upstream line count: newline count, +1 for a trailing fragment. Only
// called on files with >= minTokens tokens, so source is never empty.
function lineCount(source) {
  const newlines = source.split('\n').length - 1;
  return source.endsWith('\n') ? newlines : newlines + 1;
}

// Indexes every valid window by its joined lexemes, then marks every
// token of windows seen two or more times — within or across files — as
// duplicated. Two passes when local renaming is active (upstream 94299e0):
// raw lexemes (Type-1) alongside the masked values (Type-2), unioned —
// placeholder numbering is first-use-per-scope, so the masked pass alone
// could miss exact copies whose enclosing scopes shift the numbering.
function markDuplicates(bags, minTokens, minLines, ignoreLocals) {
  if (ignoreLocals) markPass(bags, minTokens, minLines, (t) => t.lexeme);
  markPass(bags, minTokens, minLines, (t) => t.value);
}

// One detection pass over the per-token strings `codeOf` selects.
function markPass(bags, minTokens, minLines, codeOf) {
  const occurrences = new Map();
  for (let b = 0; b < bags.length; b++) {
    indexWindows(bags[b].tokens, b, minTokens, minLines, occurrences, codeOf);
  }
  for (const positions of occurrences.values()) {
    if (positions.length < 2) continue;
    for (const [b, start] of positions) {
      const tokens = bags[b].tokens;
      const limit = Math.min(start + minTokens, tokens.length);
      for (let i = start; i < limit; i++) tokens[i].dup = true;
    }
  }
}

// Sliding windows of minTokens tokens; a window is recorded only when it
// spans at least minLines source lines (first to last token).
function indexWindows(tokens, bagIndex, minTokens, minLines, occurrences, codeOf) {
  const lines = tokens.map((t) => t.line);
  for (let start = 0; start + minTokens <= tokens.length; start++) {
    if (lines[start + minTokens - 1] - lines[start] + 1 < minLines) continue;
    const key = tokens
      .slice(start, start + minTokens)
      .map(codeOf)
      .join('\u0000');
    const positions = occurrences.get(key);
    if (positions) positions.push([bagIndex, start]);
    else occurrences.set(key, [[bagIndex, start]]);
  }
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

// One-line summary mirroring the Dart gate: pass reports the tokenized
// file count and the overall duplicated-line percent, fail reports how
// many files are over the threshold.
function duplicatesSummary({ violations, checked, checkedLines, dupLines }, opts) {
  if (violations > 0) {
    return `${violations}/${checked} files over ${opts.threshold}% duplication`;
  }
  const percent = checkedLines === 0 ? 0.0 : (dupLines / checkedLines) * 100;
  return `${checked} files, ${percent.toFixed(2)}% duplicated lines`;
}
