// `banned-imports` subcommand: enforces architectural boundaries declared
// as `--from GLOB --forbid GLOB [--message MSG]` triples on the command
// line (zipped in CLI order). For every file matching a rule's `from`
// glob, each import whose specifier — or, for relative imports, its
// resolved project-relative path — matches the `forbid` glob is a
// violation. Port of crap4dart's banned_imports gate (0.5.x), which reads
// the same rules from its YAML config; crap4js has no config system, so
// the rules are CLI flags.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gateFiles, toRelPath } from './files.js';
import { runCheck } from './gateCommon.js';
import { parseSource } from './complexity.js';
import { collectImports, resolveImport } from './imports.js';

const RULE_FLAGS = { '--from': 'from', '--forbid': 'forbid', '--message': 'message' };

/**
 * Parse `banned-imports` arguments into `{ rules, paths }`. Rule flags may
 * be written `--from GLOB` or `--from=GLOB`; every other argument is a
 * path. Throws a usage error when the from/forbid/message counts do not
 * zip into valid rules.
 *
 * @param {string[]} argv
 * @returns {{rules: Array<{from: string, forbid: string, message: string|null}>, paths: string[]}}
 */
export function parseRules(argv) {
  const opts = { from: [], forbid: [], message: [], paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyRuleArg(opts, argv[i], argv, i);
  }
  validateCounts(opts);
  opts.rules = opts.from.map((from, i) => ({
    from,
    forbid: opts.forbid[i],
    message: opts.message[i] ?? null,
  }));
  return opts;
}

// Applies one argv token: a --from/--forbid/--message flag consumes a
// value (inline `--flag=v` or the next token); anything else is a path.
// Returns the index of the last consumed token.
function applyRuleArg(opts, arg, argv, i) {
  const eq = arg.indexOf('=');
  const head = eq === -1 ? arg : arg.slice(0, eq);
  const key = RULE_FLAGS[head];
  if (!key) {
    if (eq !== -1) throw new Error(`unknown flag: ${head}`);
    opts.paths.push(arg);
    return i;
  }
  const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
  if (value === undefined) throw new Error(`${head} requires a value`);
  opts[key].push(value);
  return eq === -1 ? i + 1 : i;
}

function validateCounts({ from, forbid, message }) {
  if (from.length !== forbid.length || message.length > from.length) {
    throw new Error('--from/--forbid must come in pairs; --message is optional per pair');
  }
}

/**
 * Compile a rule's glob into a RegExp (`*` matches within one path
 * segment, `**` across segments, `?` one character).
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` also matches zero segments, so `**/test` hits `test`.
        if (glob[i + 2] === '/') {
          i += 2;
          re += '(?:.*/)?';
        } else {
          i += 1;
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Banned-import violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {Array<{from: string, forbid: string, message: string|null}>} rules
 * @returns {{violations: Array<{file, message}>, checked: number}}
 */
export function bannedImportViolations(files, projectRoot, rules) {
  const compiled = rules.map((r) => ({
    from: globToRegExp(r.from),
    forbid: globToRegExp(r.forbid),
    message: r.message,
  }));
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const rel = toRelPath(file, projectRoot);
    const applicable = compiled.filter((r) => r.from.test(rel));
    if (applicable.length === 0) continue;
    checked++;
    violations.push(...violationsIn(file, rel, applicable, projectRoot));
  }
  return { violations, checked };
}

function violationsIn(file, rel, rules, projectRoot) {
  const ast = parseSource(readFileSync(file, 'utf8'), path.extname(file));
  const out = [];
  for (const spec of collectImports(ast.program)) {
    const rule = rules.find((r) => matchesForbid(r, spec, file, projectRoot));
    if (rule) {
      out.push({ file: rel, message: violationMessage(spec, rel, rule) });
    }
  }
  return out;
}

// A rule bans the specifier when the forbid glob matches the raw
// specifier or the resolved project-relative path of a relative import.
function matchesForbid(rule, spec, importerFile, projectRoot) {
  if (rule.forbid.test(spec)) return true;
  const resolved = resolveImport(spec, importerFile, projectRoot);
  return resolved !== null && rule.forbid.test(resolved);
}

function violationMessage(spec, rel, rule) {
  const extra = rule.message ? ` — ${rule.message}` : '';
  return `import ${spec} is banned for ${rel}${extra}`;
}

/**
 * One-line summary mirroring the Dart gate: `N files comply with M
 * rule(s)`, or `N banned import(s) in M files`.
 */
export function bannedSummary({ violations, checked, ruleCount }) {
  if (violations === 0) {
    return `${checked} files comply with ${ruleCount} rule(s)`;
  }
  return `${violations} banned import(s) in ${checked} files`;
}

/**
 * The `banned-imports` command body. With no rules it prints
 * `no rules configured` and passes. Usage errors (unbalanced flags,
 * unknown flags) throw and surface as exit code 1. Returns exit code 2
 * iff violations exist.
 */
export function runBannedImports(argv, ctx) {
  const { rules, paths } = parseRules(argv);
  if (rules.length === 0) {
    ctx.out.write('no rules configured\n');
    return 0;
  }
  const check = (files, root) => ({
    ...bannedImportViolations(files, root, rules),
    ruleCount: rules.length,
  });
  return runCheck(ctx, gateFiles(paths, ctx.cwd), check, bannedSummary);
}
