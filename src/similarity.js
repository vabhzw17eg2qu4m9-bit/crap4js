// File-level near-duplicate detection — port of crap4dart 0.15.0's
// similarity engine (lib/src/similarity/, upstream spec §11.23, commit
// 2b21966). Text-level, parser-free: per-profile normalization (markdown
// drops fenced code blocks; code strips comments/import-family lines and
// maps literals to placeholders), 8-token shingles, Jaccard + containment,
// transitive clusters via union-find.
//
// Upstream ships this as a config gate (opt-in, `enabled: false`) plus an
// ad-hoc exploration command. crap4js has no config file or check pipeline,
// so the port is the exploration command: the corpus is compared with the
// upstream template defaults (include **/*.md, min-shingles 50, jaccard
// 0.8, containment 0.95), overrides are kebab-case CLI flags, and the run
// is informational — always exit 0.

import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { EXCLUDE, THRESHOLD_FLAG } from './constants.js';
import { SOURCE_EXTENSIONS, UTF8, expandPaths, toRelPath } from './files.js';
import { globToRegExp } from './bannedImports.js';
import { applyGateArg } from './gateCommon.js';

// The number of consecutive tokens forming one shingle.
export const SHINGLE_SIZE = 8;

// Upstream gate template defaults (gates.similarity in crap4dart.yaml).
const DEFAULT_DIRS = ['.'];
const DEFAULT_INCLUDE = ['**/*.md'];
const DEFAULT_MIN_SHINGLES = 50;
const DEFAULT_JACCARD = 0.8;
const DEFAULT_CONTAINMENT = 0.95;
const DEFAULT_EXCLUDE = [
  '.git/**',
  '.worktrees/**',
  'node_modules/**',
  'build/**',
  'coverage/**',
];

// Content profiles (upstream SimilarityProfile enum values).
const MARKDOWN = 'markdown';
const CODE = 'code';
const RAW = 'raw';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

// Source code extensions (any language — the normalizer is
// language-agnostic token shaping).
const CODE_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  '.dart', '.java', '.py',
  '.kt', '.kts', '.swift', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.rb', '.php', '.scala', '.gradle', '.groovy', '.sh', '.sql',
]);

// Word tokens for prose and raw content: letters/digits runs of 2+
// characters (latin + cyrillic), lowercased.
const WORD_TOKEN = /[0-9A-Za-zА-Яа-яЁё]{2,}/g;

// Code tokens: identifiers, numbers and quoted strings.
const CODE_TOKEN = /[A-Za-z_][A-Za-z0-9_]*|'[^']*'|"[^"]*"|\d+(?:\.\d+)?/g;

// Line-comment markers across the code extension family.
const LINE_COMMENT = /^\s*(\/\/|#|--|;)/;

// Import-family directives across languages — boilerplate that would
// otherwise make every file of a project look like every other.
const IMPORT_LINES = [
  /^\s*(import|export|part|part of|library)\b/,
  /^\s*(from|require|require_once|using|package|include)\b/,
  /^#!/,
];

/**
 * The profile for a file path (by extension): `markdown`, `code`, or
 * `raw` for unknown extensions.
 */
export function profileFor(filePath) {
  const dot = filePath.lastIndexOf('.');
  const ext = dot < 0 ? '' : filePath.slice(dot).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return MARKDOWN;
  if (CODE_EXTENSIONS.has(ext)) return CODE;
  return RAW;
}

/**
 * Markdown prose: drops fenced code blocks, keeps heading/list words.
 */
export function normalizeMarkdown(content) {
  const kept = [];
  let inFence = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || trimmed === '') continue;
    kept.push(trimmed);
  }
  return kept.join(' ');
}

/**
 * Source code: strips block/line comments and import-family lines.
 */
export function normalizeCode(content) {
  const kept = [];
  let inBlockComment = false;
  for (const raw of content.split('\n')) {
    const [stripped, stillOpen] = stripBlockComments(raw, inBlockComment);
    inBlockComment = stillOpen;
    if (isCodeNoise(stripped)) continue;
    kept.push(stripped.trim());
  }
  return kept.join('\n');
}

// The line with its block comments removed; the boolean carries an
// unterminated `/*` across lines.
function stripBlockComments(line, inBlockComment) {
  if (inBlockComment) {
    const close = line.indexOf('*/');
    if (close < 0) return ['', true];
    return stripBlockComments(line.slice(close + 2), false);
  }
  const open = line.indexOf('/*');
  if (open < 0) return [line, false];
  const close = line.indexOf('*/', open + 2);
  if (close < 0) return [line.slice(0, open), true];
  return stripBlockComments(line.slice(0, open) + line.slice(close + 2), false);
}

// Whether a stripped code line carries no comparison signal (empty, a
// line comment, or an import-family directive).
function isCodeNoise(line) {
  const trimmed = line.trim();
  if (trimmed === '' || LINE_COMMENT.test(trimmed)) return true;
  return IMPORT_LINES.some((pattern) => pattern.test(trimmed));
}

/**
 * The normalizer for the profile; markdown and code are shaped, raw
 * content passes through.
 */
export function normalize(content, profile) {
  if (profile === MARKDOWN) return normalizeMarkdown(content);
  if (profile === CODE) return normalizeCode(content);
  return content;
}

/**
 * Splits content into comparison tokens according to the profile.
 *
 * Markdown/raw: prose words. Code: identifiers lowercased, numbers and
 * strings replaced with `N`/`S` placeholders so clones differing only in
 * literal values still match.
 */
export function tokensFor(content, profile) {
  if (profile === CODE) {
    return [...content.matchAll(CODE_TOKEN)].map((m) => codeTokenValue(m[0]));
  }
  return [...content.matchAll(WORD_TOKEN)].map((m) => m[0].toLowerCase());
}

// The comparison value of one raw code token.
function codeTokenValue(token) {
  if (token.startsWith("'") || token.startsWith('"')) return 'S';
  if (/^\d/.test(token)) return 'N';
  return token.toLowerCase();
}

// FNV-1a over one shingle as exact 64-bit arithmetic in two uint32
// halves (hi:lo). The prime 0x100000001b3 = 2^40 + 0x1b3, so one step is
// `(v ^ byte) * 2^40 + (v ^ byte) * 0x1b3` mod 2^64 — every partial
// product stays below 2^42, inside double-precision exactness. No BigInt
// (this is the scan's hot loop) and no platform-dependent float math:
// all operands are integer-exact. The result is folded to 53 bits
// (`hi & 0x1fffff` gives 21 bits, plus the low 32 — max 2^53 - 1) so a
// shingle is one exact, non-negative Number key; collisions across a
// tree's shingle count stay astronomically unlikely in the 2^53 space.
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325; // 64-bit offset basis 0xcbf29ce484222325
const FNV_PRIME_LOW = 0x1b3;
const SHINGLE_SEPARATOR = 0x1f;
const HASH_LOW_MASK = 0x1fffff;
const LOW24_MASK = 0xffffff;
const UINT32 = 4294967296;

// Mixes one byte into the [hi, lo] FNV-1a state: XOR into the low half,
// then multiply by the prime via the 2^40 + 0x1b3 decomposition.
function fnvMix(state, byte) {
  const lo = (state[1] ^ byte) >>> 0;
  const loProd = lo * FNV_PRIME_LOW;
  state[0] =
    (state[0] * FNV_PRIME_LOW + Math.floor(loProd / UINT32) + ((lo & LOW24_MASK) << 8)) % UINT32;
  state[1] = loProd % UINT32;
}

/**
 * 64-bit FNV-1a of one shingle: the 8 tokens starting at `start`, each
 * terminated by a separator unit so `["ab", "c"]` and `["a", "bc"]` hash
 * differently. Hashing keeps one Number per shingle instead of the full
 * joined token string — the shingle sets of a large tree otherwise
 * retain multi-GB of strings (IstiN/crap4dart#34). Returns a 53-bit-safe
 * non-negative value (see the constant notes above).
 */
export function shingleHash(tokens, start) {
  const state = [FNV_OFFSET_HI, FNV_OFFSET_LO];
  for (let i = start; i < start + SHINGLE_SIZE; i++) {
    const token = tokens[i];
    for (let k = 0; k < token.length; k++) fnvMix(state, token.charCodeAt(k));
    fnvMix(state, SHINGLE_SEPARATOR);
  }
  return (state[0] & HASH_LOW_MASK) * UINT32 + state[1];
}

/**
 * The set of 8-token shingle hashes of content under the profile, or an
 * empty set when there are fewer tokens than one shingle (such files
 * carry no similarity signal).
 *
 * The content is normalized for the profile first (markdown loses its
 * fenced code blocks, code loses comments/imports and keeps literal
 * placeholders) — raw bytes would make unrelated files look alike.
 */
export function shinglesFor(content, profile) {
  const tokens = tokensFor(normalize(content, profile), profile);
  if (tokens.length < SHINGLE_SIZE) return new Set();
  const shingles = new Set();
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i++) {
    shingles.add(shingleHash(tokens, i));
  }
  return shingles;
}

// The number of shingles present in both sets.
function intersectionCount(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const shingle of small) {
    if (large.has(shingle)) shared++;
  }
  return shared;
}

/**
 * The Jaccard similarity of two shingle sets: intersection over union.
 * 1.0 for identical sets, 0.0 for disjoint ones.
 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = intersectionCount(a, b);
  return shared / (a.size + b.size - shared);
}

/**
 * The containment of the smaller set in the larger one: how much of the
 * smaller file's content the larger one reproduces. Catches the "file A
 * is largely a copy of big file B" case where Jaccard stays low.
 */
export function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  return intersectionCount(a, b) / Math.min(a.size, b.size);
}

/**
 * Scans directories for text files under `projectRoot` and clusters
 * near-duplicate content by shingle similarity. `opts` takes kebab-case
 * flag values: `dirs`, `include`, `exclude` (glob lists, matched against
 * project-relative paths), `jaccard`, `containment` (thresholds; a pair
 * crosses when EITHER is met) and `minShingles` (files below the floor
 * are skipped).
 *
 * Returns `{ scanned, skipped, pairs, clusters, clean }`: pairs sorted by
 * Jaccard descending, clusters (groups of ≥ 2 files) largest first.
 */
export function analyzeSimilarity(projectRoot, opts) {
  const include = opts.include.map(globToRegExp);
  const exclude = opts.exclude.map(globToRegExp);
  const files = collect(projectRoot, opts.dirs, include, exclude);
  if (files.length > MAX_SCAN_FILES) {
    throw new Error(
      `similarity scan scope matches ${files.length} files, above the ` +
        `${MAX_SCAN_FILES}-file safety cap: narrow --include or the positional ` +
        'dirs, or extend --exclude',
    );
  }
  const analyzed = [];
  let skipped = 0;
  for (const file of files) {
    const shingles = shinglesFor(
      readFileSync(file, UTF8),
      profileFor(toRelPath(file, projectRoot)),
    );
    if (shingles.size < opts.minShingles) {
      skipped++;
      continue;
    }
    analyzed.push({ path: toRelPath(file, projectRoot), shingles });
  }
  const pairs = pairsOverThresholds(
    analyzed,
    opts.jaccard,
    opts.containment,
  );
  return {
    scanned: analyzed.length,
    skipped,
    pairs,
    clusters: similarityClusters(analyzed, pairs),
    clean: pairs.length === 0,
  };
}

// Non-excluded files matching include under dirs, sorted by
// project-relative path.
function collect(projectRoot, dirs, include, exclude) {
  const keep = (file) =>
    matchesAny(include, toRelPath(file, projectRoot)) &&
    !matchesAny(exclude, toRelPath(file, projectRoot));
  const collected = new Set();
  for (const dir of dirs) {
    const target = path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
    for (const file of expandPaths([target], projectRoot, keep)) {
      collected.add(file);
    }
  }
  return [...collected].sort(
    (a, b) =>
      toRelPath(a, projectRoot).localeCompare(toRelPath(b, projectRoot)),
  );
}

function matchesAny(globs, relPath) {
  return globs.some((glob) => glob.test(relPath));
}

// Hard ceiling on the number of files one scan analyzes. Beyond this the
// scan is almost certainly an over-broad include/dirs scope (vendored
// checkouts, generated corpora) that would exhaust memory on the shingle
// index; analyzeSimilarity throws instead of crashing the whole check
// run.
export const MAX_SCAN_FILES = 20000;

// Shingle hashes shared by more files than this carry no duplicate
// signal (boilerplate) and are skipped when building pair candidates.
const MAX_POSTINGS = 100;

// Maps every shingle hash to the indexes of the files containing it.
function invertedIndex(files) {
  const index = new Map();
  for (let i = 0; i < files.length; i++) {
    for (const hash of files[i].shingles) {
      const postings = index.get(hash);
      if (postings) postings.push(i);
      else index.set(hash, [i]);
    }
  }
  return index;
}

// Unique ordered pairs within one postings list, skipping pairs already
// emitted (tracked via seen of flattened i * width + j keys that grows
// with the candidate count, not the quadratic pair space).
function postingsPairs(files, postings, seen) {
  const pairs = [];
  const width = files.length;
  for (let x = 0; x < postings.length; x++) {
    for (let y = x + 1; y < postings.length; y++) {
      const i = postings[x];
      const j = postings[y];
      const flat = i * width + j;
      if (seen.has(flat)) continue;
      seen.add(flat);
      pairs.push([files[i], files[j]]);
    }
  }
  return pairs;
}

// Whether a postings list yields pair candidates: fewer than 2 files
// share the shingle (no pair), more than MAX_POSTINGS carry no duplicate
// signal (boilerplate — skipped).
function isCandidatePostings(count) {
  return count >= 2 && count <= MAX_POSTINGS;
}

// Unique file pairs sharing at least one shingle hash, via an inverted
// index. A pair can only cross a positive threshold when the two files
// share at least one shingle hash, so exact Jaccard / containment run on
// candidate pairs only — the naive all-pairs loop is quadratic in the
// file count and made large trees effectively hang (IstiN/crap4dart#34).
function candidatePairs(files) {
  const index = invertedIndex(files);
  const seen = new Set();
  const pairs = [];
  for (const postings of index.values()) {
    if (isCandidatePostings(postings.length)) {
      pairs.push(...postingsPairs(files, postings, seen));
    }
  }
  return pairs;
}

// All pairs crossing either threshold, strongest first.
function pairsOverThresholds(files, jaccardThreshold, containmentThreshold) {
  const pairs = [];
  for (const [a, b] of candidatePairs(files)) {
    const jScore = jaccard(a.shingles, b.shingles);
    const cScore = containment(a.shingles, b.shingles);
    if (jScore < jaccardThreshold && cScore < containmentThreshold) continue;
    pairs.push({ a: a.path, b: b.path, jaccard: jScore, containment: cScore });
  }
  return pairs.sort((x, y) => y.jaccard - x.jaccard);
}

// Transitive clusters of the threshold-crossing pairs, largest first.
function similarityClusters(files, pairs) {
  const parent = new Map(files.map((f) => [f.path, f.path]));
  const find = (item) => {
    while (parent.get(item) !== item) item = parent.get(item);
    return item;
  };
  for (const pair of pairs) {
    const ra = find(pair.a);
    const rb = find(pair.b);
    if (ra !== rb) parent.set(rb, ra);
  }
  const groups = new Map();
  for (const file of files) {
    const root = find(file.path);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(file.path);
  }
  return [...groups.values()]
    .filter((members) => members.length > 1)
    .map((members) => ({
      files: members.sort(),
      pairs: pairs.filter(
        (p) => members.includes(p.a) && members.includes(p.b),
      ),
    }))
    .sort((x, y) => y.files.length - x.files.length);
}

/**
 * The strongest pair metrics (highest Jaccard) a path participates in,
 * or null when the file is in no pair.
 */
export function metricsFor(report, filePath) {
  let best = null;
  for (const pair of report.pairs) {
    if (pair.a !== filePath && pair.b !== filePath) continue;
    if (best === null || pair.jaccard > best.jaccard) best = pair;
  }
  return best;
}

const VALUE_FLAGS = {
  '--format': 'format',
  '--jaccard': 'jaccard',
  '--containment': 'containment',
  '--min-shingles': 'minShingles',
  '--include': 'include',
  '--exclude': EXCLUDE,
};
const NUMBER_FLAGS = new Set(['--jaccard', '--containment', '--min-shingles']);
const FORMATS = new Set(['console', 'json']);

/**
 * Parse `similarity` arguments into `{ format, jaccard, containment,
 * minShingles, include, exclude, paths }`. Value flags may be written
 * `--flag VALUE` or `--flag=VALUE`; `--include` and `--exclude` are
 * repeatable and replace the defaults when passed. `--jaccard` and
 * `--containment` are 0.0-1.0; `--min-shingles` is a non-negative
 * integer; `--format` is `console` (the default) or `json`. Invalid
 * values throw (the CLI reports a usage error).
 *
 * @param {string[]} argv
 */
export function parseSimilarityArgs(argv) {
  const opts = {
    format: 'console',
    jaccard: DEFAULT_JACCARD,
    containment: DEFAULT_CONTAINMENT,
    minShingles: DEFAULT_MIN_SHINGLES,
    include: [],
    exclude: [],
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  validateSimilarityOpts(opts);
  return opts;
}

// Strict flag validation (upstream's strict loader checks, mapped to the
// port's usage-error contract): invalid values throw.
function validateSimilarityOpts(opts) {
  if (!FORMATS.has(opts.format)) {
    throw new Error(`Invalid --format: ${opts.format}`);
  }
  for (const [name, value] of [
    ['--jaccard', opts.jaccard],
    ['--containment', opts.containment],
  ]) {
    if (!(value >= 0 && value <= 1)) {
      throw new Error(`Invalid ${name}: ${value}`);
    }
  }
  if (!Number.isInteger(opts.minShingles) || opts.minShingles < 0) {
    throw new Error(`Invalid --min-shingles: ${opts.minShingles}`);
  }
}

/**
 * The `similarity` command body: near-duplicate scan over any text
 * corpus — the exploration tool for tuning thresholds. Informational:
 * always exits 0.
 */
export function runSimilarity(argv, ctx) {
  const opts = parseSimilarityArgs(argv);
  const [scanRoot, dirs] = scanTargets(ctx.cwd, opts.paths);
  const report = analyzeSimilarity(scanRoot, {
    dirs,
    include: opts.include.length ? opts.include : DEFAULT_INCLUDE,
    exclude: opts.exclude.length ? opts.exclude : DEFAULT_EXCLUDE,
    jaccard: opts.jaccard,
    containment: opts.containment,
    minShingles: opts.minShingles,
  });
  if (opts.format === 'json') {
    ctx.out.write(`${JSON.stringify(jsonReport(report, opts), null, 2)}\n`);
  } else {
    printConsole(report, opts, ctx.out);
  }
  return 0;
}

// The scan root and directories for this invocation: a single directory
// argument becomes the scan root itself, several arguments are
// subdirectories of the project root, none uses the default dirs.
function scanTargets(projectRoot, rest) {
  if (rest.length === 1 && isDirectory(path.resolve(projectRoot, rest[0]))) {
    return [path.resolve(projectRoot, rest[0]), ['.']];
  }
  if (rest.length > 0) return [projectRoot, rest];
  return [projectRoot, DEFAULT_DIRS];
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function printConsole(report, opts, out) {
  out.write(
    `similarity: ${report.scanned} files scanned ` +
      `(${report.skipped} skipped below ${opts.minShingles} shingles), ` +
      `thresholds jaccard >= ${opts.jaccard} / containment >= ${opts.containment}\n`,
  );
  if (report.clean) {
    out.write('no similar files\n');
    return;
  }
  report.clusters.forEach((cluster, i) => {
    out.write(`\ncluster ${i + 1} — ${cluster.files.length} files:\n`);
    for (const file of cluster.files) {
      const metrics = metricsFor(report, file);
      out.write(
        `  ${file} (jaccard ${metrics.jaccard.toFixed(2)}, ` +
          `containment ${metrics.containment.toFixed(2)})\n`,
      );
    }
  });
  const clustered = report.clusters.reduce((n, c) => n + c.files.length, 0);
  out.write(`\n${clustered} files in ${report.clusters.length} clusters\n`);
}

// The JSON report shape (upstream `min_shingles` key kept).
function jsonReport(report, opts) {
  const round = (x) => Number(x.toFixed(4));
  return {
    scanned: report.scanned,
    skipped: report.skipped,
    thresholds: {
      jaccard: opts.jaccard,
      containment: opts.containment,
      min_shingles: opts.minShingles,
    },
    pairs: report.pairs.map((p) => ({
      a: p.a,
      b: p.b,
      jaccard: round(p.jaccard),
      containment: round(p.containment),
    })),
    clusters: report.clusters.map((c) => ({ files: c.files })),
  };
}
