// `duplicates` subcommand: token-based duplicate-code detection. Port of
// crap4dart's duplication gate (spec §11.11) including the per-gate
// `sources` union (commit dc64e9c): every scanned file is tokenized
// (comments skipped, raw lexemes kept), and any sliding window of
// `--min-tokens` tokens spanning at least `--min-lines` source lines that
// appears twice or more — within or across files — marks its tokens as
// duplicated. A file violates when its distinct duplicated lines exceed
// `--threshold` percent of its total lines.
//
// ponytail: windows are indexed by their joined lexeme string (NUL-
// separated, a byte no lexeme contains), not upstream's Rabin-Karp hash —
// same windows, no collision handling; switch to rolling hashes only if
// scan time on very large files ever matters.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expandPaths, gateFiles, isAnySourceFile, isTestPath, toRelPath } from './files.js';
import { globToRegExp } from './bannedImports.js';
import { tokenizeSource } from './complexity.js';
import { applyGateArg, runCheck } from './gateCommon.js';

const DEFAULT_THRESHOLD = 1;
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

/**
 * Parse `duplicates` arguments into `{ threshold, minTokens, minLines,
 * exclude, source, paths }`. Value flags may be written `--flag VALUE` or
 * `--flag=VALUE`; `--exclude` and `--source` are repeatable.
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
    i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
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
 * @param {{threshold: number, minTokens: number, minLines: number}} opts
 * @returns {{violations: Array<{file, line, message}>, checked: number,
 *            checkedLines: number, dupLines: number}}
 */
export function duplicatesViolations(files, projectRoot, opts) {
  const bags = tokenizeFiles(files, projectRoot, opts.minTokens);
  markDuplicates(bags, opts.minTokens, opts.minLines);
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

// Reads and tokenizes each scanned file. Tokens are `{ value, line }`
// pairs plus a `dup` marker added during detection; `totalLines` uses the
// upstream line count (newlines, +1 for a trailing fragment, 0 when
// empty).
function tokenizeFiles(files, projectRoot, minTokens) {
  const bags = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const tokens = tokenizeSource(source, path.extname(file));
    if (tokens.length >= minTokens) {
      bags.push({
        rel: toRelPath(file, projectRoot),
        tokens,
        totalLines: lineCount(source),
      });
    }
  }
  return bags;
}

// Upstream line count: newline count, +1 for a trailing fragment. Only
// called on files with >= minTokens tokens, so source is never empty.
function lineCount(source) {
  const newlines = source.split('\n').length - 1;
  return source.endsWith('\n') ? newlines : newlines + 1;
}

// Indexes every valid window by its joined lexemes, then marks every
// token of windows seen two or more times — within or across files — as
// duplicated.
function markDuplicates(bags, minTokens, minLines) {
  const occurrences = new Map();
  for (let b = 0; b < bags.length; b++) {
    indexWindows(bags[b].tokens, b, minTokens, minLines, occurrences);
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
function indexWindows(tokens, bagIndex, minTokens, minLines, occurrences) {
  const lines = tokens.map((t) => t.line);
  for (let start = 0; start + minTokens <= tokens.length; start++) {
    if (lines[start + minTokens - 1] - lines[start] + 1 < minLines) continue;
    const key = tokens
      .slice(start, start + minTokens)
      .map((t) => t.value)
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
