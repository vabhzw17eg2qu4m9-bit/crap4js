// `reorder` subcommand: a deterministic source transform (not a gate) that
// rewrites class members into the canonical JS order. Port of crap4dart
// 0.22.0's reorder command (upstream spec §11.24, commit 24a6f24f).
//
// Canonical order — the documented host adaptation of the upstream Dart
// table (JS has no const-field kind, so static constants live with the
// static fields):
//
//   1. static fields    static x, static blocks, static #x (constants too)
//   2. instance fields  x, #x, accessor x
//   3. constructor
//   4. static methods   public static m()
//   5. getters/setters  get/set at any staticness, incl. #get/#set
//   6. public methods
//   7. private methods  #m() at any staticness
//
// Kind wins over staticness (a static getter is an accessor, not a static
// method). Same-kind members keep their relative order — a stable
// partition, never an alphabetical sort. NOTE: a js-only deviation —
// upstream FINAL and crap4py bucket isStatic first (a static getter lands
// in static methods); here kind wins, keeping all accessors in one run.
//
// Deterministic: the same input always produces the same output,
// already-canonical files stay byte-identical whatever their layout (the
// body is rewritten only when the category sequence actually changes), and
// the transform is idempotent (fix(fix(x)) == fix(x)). Doc comments and
// whole-line // blocks directly above a member move with it — across ONE
// blank line; two blank lines detach the block. Orphan comments before the
// first member or after the last one stay put. The file's line-ending
// style (LF or CRLF) is preserved.
//
// Scope: top-level class declarations only (incl. export / export default).
// TS enums and object literals are never touched (member order is
// semantics); nested classes and class expressions are left alone, like
// upstream leaves everything below the compilation unit.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  UTF8,
  expandPaths,
  findSourceFiles,
  isAnySourceFile,
  toRelPath,
} from './files.js';
import { parseSource } from './complexity.js';

const STATIC_FIELDS = 0;
const FIELDS = 1;
const CONSTRUCTORS = 2;
const STATIC_METHODS = 3;
const ACCESSORS = 4;
const METHODS = 5;
const PRIVATE_METHODS = 6;

const FIELD_TYPES = new Set([
  'ClassProperty',
  'ClassPrivateProperty',
  'ClassAccessorProperty',
]);
const METHOD_TYPES = new Set(['ClassMethod', 'ClassPrivateMethod']);

// Category index of one class member in the canonical order above.
export function categoryOf(member) {
  if (member.type === 'StaticBlock') return STATIC_FIELDS;
  if (FIELD_TYPES.has(member.type)) return fieldCategory(member);
  if (METHOD_TYPES.has(member.type)) return methodCategory(member);
  return METHODS; // TSDeclareMethod, TSAbstract*, anything else
}

function fieldCategory(member) {
  return member.static ? STATIC_FIELDS : FIELDS;
}

function methodCategory(member) {
  if (member.kind === 'constructor') return CONSTRUCTORS;
  if (member.kind !== 'method') return ACCESSORS; // get / set
  if (member.type === 'ClassPrivateMethod') return PRIVATE_METHODS;
  return member.static ? STATIC_METHODS : METHODS;
}

/**
 * Deterministically reorder the members of every top-level class in
 * `source` into the canonical order. Throws on parse errors (the caller
 * skips the file with a note).
 *
 * @param {string} source  JavaScript/JSX/Flow/TypeScript source code.
 * @param {string} [ext]  File extension routing flow vs typescript plugins.
 * @returns {string} the reordered source (byte-identical when canonical).
 */
export function reorderSource(source, ext) {
  const ast = parseSource(source, ext);
  if (ast.errors?.length > 0) throw new Error('parse error');
  const starts = lineStarts(source);
  const comments = ast.comments;
  const replacements = [];
  for (const cls of topLevelClasses(ast.program)) {
    const rep = reorderedSpan(source, starts, comments, cls);
    if (rep) replacements.push(rep);
  }
  let out = source;
  // Apply back-to-front so earlier offsets stay valid.
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { start, end, text } = replacements[i];
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}

// Top-level class declarations, unwrapping export / export default.
function topLevelClasses(program) {
  const out = [];
  for (const stmt of program.body) {
    const wrapped = stmt.type === 'ExportNamedDeclaration'
      || stmt.type === 'ExportDefaultDeclaration';
    const decl = wrapped ? stmt.declaration : stmt;
    if (decl?.type === 'ClassDeclaration') out.push(decl);
  }
  return out;
}

// The body replacement for one class, or null when its members already
// follow the canonical order (byte-identical whatever the layout).
function reorderedSpan(source, starts, comments, cls) {
  const members = cls.body.body;
  if (members.length < 2) return null;
  const slices = members.map((m, i) => sliceOf(
    source,
    starts,
    comments,
    m,
    i === 0 ? cls.body.start + 1 : members[i - 1].end,
    i,
  ));
  const sorted = [...slices].sort(
    (a, b) => a.category - b.category || a.index - b.index,
  );
  if (sorted.every((s, i) => s.index === i)) return null;
  const separator = source.includes('\r\n') ? '\r\n\r\n' : '\n\n';
  const spanStart = Math.min(...slices.map((s) => s.start));
  const bodyEnd = Math.max(...slices.map((s) => s.end));
  // The tail between the last member and the class's closing brace
  // (trailing orphan comments, the brace itself) stays put.
  return {
    start: spanStart,
    end: cls.end,
    text: sorted.map((s) => s.gap + source.slice(s.start, s.end)).join(separator)
      + source.slice(bodyEnd, cls.end),
  };
}

// One sliced member: its source span (with attached comments) plus sort keys.
function sliceOf(source, starts, comments, member, boundary, index) {
  let first = member.start; // babel starts decorated members at the decorator
  let line = lineOf(starts, first);
  const floor = lineOf(starts, boundary);
  const doc = blockDocBefore(source, starts, comments, line, floor);
  if (doc >= 0) {
    first = doc;
    line = lineOf(starts, doc);
  }
  // Never walk or slice above the previous member (or the opening brace).
  const start = Math.max(starts[walkCommentLines(source, starts, line, floor)], boundary);
  // Bytes the walk skipped over (a detached comment block between this
  // member and the previous one) travel WITH this member - dropping them
  // would corrupt the file. The first member's gap lies inside the
  // already-preserved prefix, and whitespace-only gaps are left to the
  // separator.
  const gapText = source.slice(boundary, start);
  return {
    category: categoryOf(member),
    index,
    start,
    end: member.end,
    gap: index > 0 && gapText.trim() !== '' ? gapText : '',
  };
}

// Start offset of a block doc comment that ends on the line directly above
// `line` (whole-line comment only), or -1. Mirrors the upstream analyzer's
// doc-comment attachment: directly above attaches, a blank line detaches.
function blockDocBefore(source, starts, comments, line, floor) {
  const above = line - 1;
  if (above < floor) return -1;
  const lineStart = starts[above];
  let found = -1;
  for (const c of comments) {
    if (c.type !== 'CommentBlock' || lineOf(starts, c.end) !== above) continue;
    if (c.start >= lineStart && source.slice(lineStart, c.start).trim() !== '') continue;
    found = c.start; // comments are position-ordered: last match = closest
  }
  return found;
}

// Extends a member's first-token line upward over whole-line // comments
// attached directly above it. A blank line continues the run only when the
// line above it is a comment: one blank line between a comment block and
// its member keeps them together, two (or a member boundary) detach.
function walkCommentLines(source, starts, line, floor) {
  while (line - 1 >= floor) {
    const text = lineText(source, starts, line - 1).trim();
    if (text.startsWith('//')) {
      line -= 1;
      continue;
    }
    if (text === '' && line - 2 >= floor
        && lineText(source, starts, line - 2).trim().startsWith('//')) {
      line -= 2;
      continue;
    }
    break;
  }
  return line;
}

// Offsets of every line start (line 0 starts at 0).
function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

// 0-based index of the line containing `offset`.
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// The text of `line` without its terminator (a trailing \r trims away).
function lineText(source, starts, line) {
  const end = line + 1 < starts.length ? starts[line + 1] - 1 : source.length;
  return source.slice(starts[line], end);
}

/**
 * The `reorder` command body: rewrites the selected files (default: the
 * src/ walk) so class members follow the canonical order. With --dry-run
 * nothing is written; exits 2 when any file would change.
 *
 * @param {string[]} args  CLI arguments after the subcommand name.
 * @param {object} ctx  { out, cwd } as built by the CLI.
 * @returns {number} exit code.
 */
export function runReorder(args, ctx) {
  const { dryRun, paths } = parseReorderArgs(args);
  const files = paths.length > 0
    ? expandPaths(paths, ctx.cwd, isAnySourceFile)
    : findSourceFiles(ctx.cwd);
  if (files.length === 0) {
    ctx.out.write(`No source files found under: ${paths.join(', ') || 'src'}\n`);
    return 0;
  }
  return applyReorder(files, dryRun, ctx);
}

// Rewrites the selected files and prints the per-file notes plus the
// summary. Returns 0 (canonical or written) or 2 (dry-run would change).
function applyReorder(files, dryRun, ctx) {
  let changed = 0;
  for (const file of files) {
    if (reorderFile(file, dryRun, ctx)) changed += 1;
  }
  if (changed === 0) {
    ctx.out.write(`All ${files.length} files already canonical.\n`);
    return 0;
  }
  const verb = dryRun ? 'would be reordered' : 'reordered';
  ctx.out.write(`${changed} of ${files.length} files ${verb}.\n`);
  return dryRun ? 2 : 0;
}

function parseReorderArgs(args) {
  const out = { dryRun: false, paths: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    else out.paths.push(a);
  }
  return out;
}

// Reorders one file, reporting the outcome; returns whether it changed.
function reorderFile(file, dryRun, ctx) {
  const original = readFileSync(file, UTF8);
  let reordered;
  try {
    reordered = reorderSource(original, path.extname(file));
  } catch {
    ctx.out.write(`skipped (parse error): ${toRelPath(file, ctx.cwd)}\n`);
    return false;
  }
  if (reordered === original) return false;
  if (!dryRun) writeFileSync(file, reordered, UTF8);
  ctx.out.write(`${dryRun ? 'would reorder' : 'reordered'} ${toRelPath(file, ctx.cwd)}\n`);
  return true;
}
