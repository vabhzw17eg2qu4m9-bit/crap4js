// Ignore-comment suppression for the gate-check subcommands, ported from
// crap4dart 8abb64c (`lib/src/gates/ignore_filter.dart`). JS adaptation:
// the markers live in `//` comments only (block comments are out of scope).
//
// Legacy blanket markers (kept unchanged, upstream 0.5.0 semantics):
//   // crap:ignore        line scope — the violation line or the line above
//   // crap:ignore-file   file scope — anywhere in the first 5 lines
// Granular markers, Dart-lint style — one gate id per marker:
//   // ignore:<gate-id>        line scope, as above
//   // ignore-file:<gate-id>   file scope, as above
// Several markers on one line union their ids; an empty id (`// ignore:`)
// matches every ignorable gate; a comma-list is one unknown id — it names
// nothing, like any unknown id. Stacked whole-line markers directly above
// the violation all apply (the walk stops at the first non-marker line).
// Suppression applies only to gates in IGNORABLE_GATES — upstream's
// per-gate `ignorable: true` config opt-in, hard-coded here (crap4js has
// no config file): the violation-reporting gate subcommands are ignorable,
// while the informational non-gates (profile, memory, similarity, skill),
// the directory-level folder-structure check, and mutation (score/summary
// aggregates would desync from the filtered list) are not.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8 } from './files.js';

// The gate subcommands that honor ignore markers — the runCheck-based
// gates with file-level violations, keyed by subcommand id. File-level-only
// gates (file-naming, unused-files) report violations without a line, so
// only file-scoped markers apply to them. `folder-structure` is excluded:
// its violations name directories, which no comment marker can address.
// `mutation` is excluded: its summary carries the pre-aggregated score
// (killed/survived counts), so dropping a suppressed survivor from the
// printed list would desync the score from the list.
export const IGNORABLE_GATES = new Set([
  'banned-imports',
  'class-size',
  'duplicates',
  'file-naming',
  'identical-branches',
  'inline-anon-types',
  'magic-constants',
  'nesting',
  'scattered-constants',
  'string-hazards',
  'test-assertions',
  'unused-code',
  'unused-files',
  'weight-of-class',
]);

const LEGACY_LINE_MARKER = 'crap:ignore';
const LEGACY_FILE_MARKER = 'crap:ignore-file';
const FILE_MARKER_LINES = 5;

// One gate id per marker; the id ends at the next whitespace or comment
// start (`[^\s/]*`), so `// ignore:a // ignore:b` carries two ids and
// `// ignore:a,b` carries the single unknown id `a,b`.
const IGNORE_LINE_RULE = /\/\/\s*ignore:([^\s/]*)/g;
const IGNORE_FILE_RULE = /\/\/\s*ignore-file:([^\s/]*)/g;

// The gate-id set carried by one ignore comment: `blanket` marks the
// no-id form (suppress everything ignorable), `ids` the named gates.
const EMPTY_SCOPE = { blanket: false, ids: new Set() };
const BLANKET_SCOPE = { blanket: true, ids: new Set() };

function unionScopes(a, b) {
  return {
    blanket: a.blanket || b.blanket,
    ids: new Set([...a.ids, ...b.ids]),
  };
}

function scopeMatches(scope, gateId) {
  return scope.blanket || scope.ids.has(gateId);
}

// Parses every ignore comment on one source line and unions their gate
// ids — one gate per marker.
function parseLine(line, rule) {
  let scope = EMPTY_SCOPE;
  for (const match of line.matchAll(rule)) {
    const id = match[1].trim();
    scope = unionScopes(scope, id === '' ? BLANKET_SCOPE : { blanket: false, ids: new Set([id]) });
  }
  return scope;
}

/**
 * Drops violations of ignorable gates suppressed by ignore markers.
 *
 * A violation is suppressed when its file carries a file-scoped marker
 * naming the gate within the first 5 lines, or when the violation's line
 * or the run of whole-line markers directly above it names it. Violations
 * without a line number are only suppressed by file-scoped markers.
 * Gates outside IGNORABLE_GATES are never suppressed (upstream's opt-in);
 * files that cannot be read are never ignored.
 *
 * @param {{violations: Array<{file, line?, message}>}} result  a gate's
 *   findViolations result — returned as-is when nothing is suppressed.
 * @param {string} gateId  the owning subcommand's id (`nesting`, ...).
 * @param {string} projectRoot  absolute root violation files resolve against.
 */
export function filterIgnored(result, gateId, projectRoot) {
  if (!IGNORABLE_GATES.has(gateId) || result.violations.length === 0) return result;
  const linesOf = fileLinesCache(projectRoot);
  const kept = result.violations.filter((v) => !isIgnored(v, gateId, linesOf));
  return kept.length === result.violations.length ? result : { ...result, violations: kept };
}

function isIgnored(violation, gateId, linesOf) {
  const lines = linesOf(violation.file);
  if (!lines) return false;
  if (fileMarkerSuppresses(lines, gateId)) return true;
  if (violation.line == null) return false;
  return lineMarkerSuppresses(lines, violation.line, gateId);
}

// Whether the file's first five lines carry a file-scoped marker
// suppressing the gate.
function fileMarkerSuppresses(lines, gateId) {
  let blanket = false;
  let scope = EMPTY_SCOPE;
  for (const line of lines.slice(0, FILE_MARKER_LINES)) {
    if (line.includes(LEGACY_FILE_MARKER)) blanket = true;
    scope = unionScopes(scope, parseLine(line, IGNORE_FILE_RULE));
  }
  return blanket || scopeMatches(scope, gateId);
}

// Whether the violation line carries a suppressing marker itself, or the
// run of whole-line ignore markers directly above it names the gate —
// stacked `// ignore: a` / `// ignore: b` lines all apply to the code line
// that ends the run.
function lineMarkerSuppresses(lines, lineNo, gateId) {
  if (lineSuppresses(lines[lineNo - 1], gateId)) return true;
  for (let i = lineNo - 2; i >= 0; i--) {
    if (lineSuppresses(lines[i], gateId)) return true;
    if (!isWholeLineMarker(lines[i])) return false;
  }
  return false;
}

// Whether the line carries any marker suppressing the gate — the legacy
// blanket marker or a granular one naming the gate. The legacy substring
// check also matches `crap:ignore-file` lines (upstream parity).
function lineSuppresses(source, gateId) {
  if (!source) return false;
  return source.includes(LEGACY_LINE_MARKER) || scopeMatches(parseLine(source, IGNORE_LINE_RULE), gateId);
}

// Whether the line is nothing but an ignore comment — only such lines
// continue the stacked-marker run above a violation.
function isWholeLineMarker(line) {
  const trimmed = (line ?? '').trim();
  return trimmed.startsWith('// ignore:') || trimmed.startsWith('// ignore-file:');
}

// Reads each violation file at most once per filter call: absolute paths
// as given, relative ones against the project root (null when unreadable).
function fileLinesCache(projectRoot) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      try {
        const p = path.isAbsolute(file) ? file : path.join(projectRoot, file);
        cache.set(file, readFileSync(p, UTF8).split('\n'));
      } catch {
        cache.set(file, null);
      }
    }
    return cache.get(file);
  };
}
