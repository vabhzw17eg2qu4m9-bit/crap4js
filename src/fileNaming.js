// `file-naming` subcommand: flags mechanical source file names produced by
// splitting code without a domain boundary — numeric suffixes (`batch1.js`,
// `report2.js`) and generic dumping-ground names (`utils.js`, `helpers.js`).
// Port of crap4dart's file_naming gate (0.4.0).

import path from 'node:path';
import { expandPaths, findSourceFiles, isTestFile } from './files.js';

// Lower-cased generic stems with no domain meaning. Files with these names
// accumulate unrelated declarations over time.
const GENERIC_STEMS = new Set([
  'common',
  'core',
  'general',
  'helper',
  'helpers',
  'misc',
  'shared',
  'stuff',
  'temp',
  'tmp',
  'types',
  'util',
  'utils',
  'utilities',
  'utility',
  'various',
]);

// Stems accepted despite ending in digits — technical terms where the digits
// carry meaning. Mirrors crap4dart's defaultAllowedStems.
const ALLOWED_STEMS = new Set([
  'aes128', 'aes192', 'aes256', 'arm32', 'arm64', 'base32', 'base64',
  'crc8', 'crc16', 'crc32', 'f16', 'f32', 'f64', 'h264', 'h265', 'http2',
  'http3', 'i18n', 'i2c', 'int8', 'int16', 'int32', 'int64', 'ipv4',
  'ipv6', 'l10n', 'a11y', 'md5', 'oauth1', 'oauth2', 'sha1', 'sha256',
  'sha384', 'sha512', 'uint8', 'uint16', 'uint32', 'uint64', 'utf8',
  'utf16', 'utf32', 'w3c', 'webgl2', 'x509', 'x86', 'x64',
]);

// Digits preceded by a letter or underscore at the end of the stem, as in
// `jira_batch1`, `report2`, `day_1` or `configv3`.
const NUMERIC_SUFFIX_RE = /[a-z_][0-9]+$/;

/**
 * Resolve the files the naming check applies to: explicit paths (expanded)
 * or the default source-selection rules. Test files and test directories
 * are always excluded.
 *
 * @param {string[]} paths  Explicit CLI paths (may be empty).
 * @param {string} projectRoot
 * @returns {string[]} absolute file paths
 */
export function namingFiles(paths, projectRoot) {
  const files =
    paths.length > 0 ? expandPaths(paths, projectRoot) : findSourceFiles(projectRoot);
  return files.filter((f) => !isTestPath(f));
}

/**
 * Check files for mechanical names.
 *
 * @param {string[]} files  absolute paths
 * @param {string} projectRoot
 * @returns {{violations: Array<{file: string, message: string}>, checked: number}}
 */
export function namingViolations(files, projectRoot) {
  const violations = [];
  for (const file of files) {
    const message = violationFor(file);
    if (message) {
      violations.push({ file: relPath(file, projectRoot), message });
    }
  }
  return { violations, checked: files.length };
}

/**
 * One-line summary: `N/M files with mechanical names` on violations,
 * `M files have domain-meaningful names` otherwise.
 */
export function namingSummary({ violations, checked }) {
  return violations.length === 0
    ? `${checked} files have domain-meaningful names`
    : `${violations.length}/${checked} files with mechanical names`;
}

/**
 * The `file-naming` command body. Prints one line per violation (relative
 * path + message) and a summary. Returns exit code 2 iff violations exist.
 */
export function runFileNaming(paths, ctx) {
  const files = namingFiles(paths, ctx.cwd);
  if (files.length === 0) {
    ctx.out.write('No source files to check.\n');
    return 0;
  }
  const result = namingViolations(files, ctx.cwd);
  for (const v of result.violations) {
    ctx.out.write(`${v.file}: ${v.message}\n`);
  }
  ctx.out.write(namingSummary(result) + '\n');
  return result.violations.length > 0 ? 2 : 0;
}

// Returns the violation message for a file, or null when the name is fine.
function violationFor(file) {
  const base = path.basename(file);
  const stem = base.slice(0, base.length - path.extname(file).length);
  const lower = stem.toLowerCase();
  if (GENERIC_STEMS.has(lower)) {
    return `generic name "${base}" — split by domain instead of accumulating unrelated declarations`;
  }
  if (NUMERIC_SUFFIX_RE.test(lower) && !ALLOWED_STEMS.has(lower)) {
    return `numeric suffix in "${base}" — split by domain instead of numbered parts (batch1, part2, v2 ...)`;
  }
  return null;
}

// True for colocated test files and anything under a test/tests/__tests__
// directory segment (checked on directory names only, so src/testing.js
// stays a normal source file).
function isTestPath(p) {
  const norm = String(p).split(path.sep).join('/');
  return isTestFile(norm) || /(^|\/)(test|tests)\//.test(norm);
}

function relPath(file, projectRoot) {
  return path.relative(projectRoot, file).split(path.sep).join('/');
}
