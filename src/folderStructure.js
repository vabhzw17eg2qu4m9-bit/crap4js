// `folder-structure` subcommand: flags directories holding more than their
// cap of logical source units DIRECTLY — a flat-file sprawl that should be
// organized into feature packages. Port of crap4dart's folder_structure gate
// (753c3580); crap4js has no config, so upstream's YAML keys map to flags:
// `--dir GLOB` (repeatable; literal path or glob expanding to every matching
// directory) plus one shared `--max-loose-files` is the classic form, and
// repeatable `--cap PATTERN:N` entries are the per-pattern `config` map —
// when present they take precedence and --dir/--max-loose-files are not
// consulted (a directory matched by several caps uses the first one's).
// `--exclude GLOB` exempts files from the count. Generated siblings of one
// source file collapse into one logical unit (`magic.js`, `magic.d.ts`,
// `magic.min.js` share the stem `magic`). Only direct children count —
// files in subdirectories are the organized form, never the parent's budget.

import path from 'node:path';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { globToRegExp } from './bannedImports.js';
import { COVERAGE, EXCLUDE } from './constants.js';
import { applyGateArg } from './gateCommon.js';
import { looseSourceFiles, toRelPath } from './files.js';

const MAX_LOOSE_FILES = 0;
const DIRS = ['src'];
// Generated siblings collapse into their source's stem (one logical unit).
// The js-idiomatic set: declaration files and minified bundles. Everything
// else (including `foo.g.js`) counts as its own unit.
const GENERATED_SUFFIXES = ['.d.ts', '.min.js'];
// Directories the glob expansion never enumerates — hidden entries (dot
// prefixed: .git, .idea, .nyc_output, ...) and build/tooling output.
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', COVERAGE]);

const VALUE_FLAGS = {
  '--dir': 'dirs',
  '--max-loose-files': 'maxLooseFiles',
  '--cap': 'caps',
  '--exclude': EXCLUDE,
};
const NUMBER_FLAGS = new Set(['--max-loose-files']);

/**
 * Parse `folder-structure` arguments into `{ dirs, maxLooseFiles, caps,
 * exclude }`. Value flags may be written `--flag VALUE` or `--flag=VALUE`;
 * `--dir`, `--cap` and `--exclude` are repeatable. Positional arguments
 * stay a usage error — directories are selected by flag, not by path.
 *
 * @param {string[]} argv
 */
export function parseFolderArgs(argv) {
  const opts = {
    dirs: [],
    maxLooseFiles: MAX_LOOSE_FILES,
    caps: [],
    exclude: [],
    paths: [],
  };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, VALUE_FLAGS, NUMBER_FLAGS);
  }
  if (opts.paths.length) throw new Error(`unknown argument: ${opts.paths[0]}`);
  if (!Number.isInteger(opts.maxLooseFiles)) {
    throw new Error(`Invalid --max-loose-files: ${opts.maxLooseFiles}`);
  }
  opts.caps = opts.caps.map(parseCap);
  return opts;
}

// One `--cap PATTERN:N` entry (upstream's `config` map item): N must be a
// plain non-negative decimal integer (upstream's strict loader, mapped to
// the port's usage-error contract). Number() alone is not enough — it
// accepts '' as 0, '0x2' as 2 and '1e2' as 100, which the sibling ports
// reject.
function parseCap(token) {
  const sep = token.lastIndexOf(':');
  const pattern = sep === -1 ? '' : token.slice(0, sep);
  const digits = sep === -1 ? '' : token.slice(sep + 1);
  if (!pattern || !/^\d+$/.test(digits)) {
    throw new Error(`Invalid --cap: ${token} (expected PATTERN:N with an integer N)`);
  }
  return { pattern, cap: Number(digits) };
}

/**
 * Folder-structure violations for the project.
 *
 * @param {string} projectRoot
 * @param {{dirs?: string[], maxLooseFiles?: number, caps?: Array<{pattern: string, cap: number}>, exclude?: string[]}} [opts]
 * @returns {{violations: Array<{file, message}>, checked: number}}
 */
export function folderStructureViolations(projectRoot, opts = {}) {
  const dirs = opts.dirs?.length ? opts.dirs : DIRS;
  const maxLooseFiles = opts.maxLooseFiles ?? MAX_LOOSE_FILES;
  const excludeRes = (opts.exclude ?? []).map(globToRegExp);
  // The config map takes precedence: dirs/max_loose_files not consulted.
  const checks = opts.caps?.length
    ? resolveCaps(projectRoot, opts.caps)
    : resolveDirs(projectRoot, dirs).map((dir) => ({ dir, cap: maxLooseFiles }));
  const violations = [];
  for (const { dir, cap } of checks) {
    const units = unitCount(projectRoot, path.join(projectRoot, dir), excludeRes);
    if (units > cap) {
      violations.push({
        file: dir,
        message: `${units} loose files directly in ${dir} — group them into feature packages (max ${cap})`,
      });
    }
  }
  return { violations, checked: checks.length };
}

// Every configured entry resolved to existing directories, deduped in flag
// order: a literal path passes through when it exists; a glob expands to
// every matching directory under the project root.
function resolveDirs(projectRoot, entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    for (const dir of expandEntry(projectRoot, entry)) {
      if (!seen.has(dir)) {
        seen.add(dir);
        out.push(dir);
      }
    }
  }
  return out;
}

// The `config` map form: each pattern's directories get that pattern's cap;
// a directory matched by several patterns keeps the FIRST pattern's cap.
function resolveCaps(projectRoot, caps) {
  const seen = new Set();
  const out = [];
  for (const { pattern, cap } of caps) {
    for (const dir of expandEntry(projectRoot, pattern)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push({ dir, cap });
    }
  }
  return out;
}

// One dirs/caps entry resolved to existing directories.
function expandEntry(projectRoot, entry) {
  if (statSync(path.join(projectRoot, entry), { throwIfNoEntry: false })?.isDirectory()) {
    return [entry];
  }
  const re = globToRegExp(entry);
  return walkDirs(projectRoot).filter((rel) => re.test(rel));
}

// Every directory under projectRoot as a project-relative POSIX path,
// skipping hidden and build/tooling directories — structure gates have no
// business enumerating .git or node_modules. Directory symlinks are never
// followed (upstream lists with followLinks: false): a cycle would crash
// the walk and an aliased directory would be flagged twice.
function walkDirs(projectRoot) {
  const found = [];
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const child = path.join(abs, name);
      if (!lstatSync(child, { throwIfNoEntry: false })?.isDirectory()) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      found.push(childRel);
      visit(child, childRel);
    }
  };
  visit(projectRoot, '');
  return found;
}

// Number of distinct logical units directly inside absDir: source files
// grouped by stem (generated siblings do not inflate the count), excludes
// matched on the project-relative path.
function unitCount(projectRoot, absDir, excludeRes) {
  const stems = new Set();
  for (const name of looseSourceFiles(absDir)) {
    if (excludeRes.some((re) => re.test(toRelPath(path.join(absDir, name), projectRoot)))) {
      continue;
    }
    stems.add(logicalStem(name));
  }
  return stems.size;
}

// The logical unit of a source file: the basename minus a generated suffix
// (.d.ts, .min.js) or the plain extension — `magic.js`, `magic.d.ts` and
// `magic.min.js` are one unit named `magic`.
function logicalStem(name) {
  for (const suffix of GENERATED_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name.slice(0, name.length - path.extname(name).length);
}

/**
 * One-line summary mirroring the Dart gate: `M directories organized into
 * packages`, or `N directory(ies) with loose-file sprawl`.
 */
export function folderStructureSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} directories organized into packages`
    : `${violations} directory(ies) with loose-file sprawl`;
}

/**
 * The `folder-structure` command body: parses its flags, prints one line
 * per violation plus the summary. Returns exit code 2 iff violations exist.
 */
export function runFolderStructure(argv, ctx) {
  const opts = parseFolderArgs(argv);
  const { violations, checked } = folderStructureViolations(ctx.cwd, opts);
  for (const v of violations) {
    ctx.out.write(`${v.file}: ${v.message}\n`);
  }
  ctx.out.write(folderStructureSummary({ violations: violations.length, checked }) + '\n');
  return violations.length > 0 ? 2 : 0;
}
