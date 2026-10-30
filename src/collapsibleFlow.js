// `collapsible-flow` subcommand: flags control-flow nesting that a
// semantics-preserving mechanical rewrite can flatten. Port of
// crap4dart's collapsible_flow gate (upstream spec §11.28, commit
// 7bdfd64ae1) with the JS host map — three checks, all from the
// parsed AST:
//
// 1. Collapsible if — `if (a) { if (b) X }` with no `else` on either
//    level merges into `if (a && b) X`. Short-circuit `&&` preserves
//    evaluation order, so the merge is always equivalent (including
//    `await`ed or side-effecting conditions). JS has no pattern
//    conditions (`if (x case P)` is Dart-only), so upstream's
//    pattern-clause exclusion has no analog here.
// 2. Redundant else — `if (c) { return X; } else { Y }` where the
//    then-branch always exits (`return`/`break`/`continue`/`throw`, a
//    block ending in one of those, an if/else pair whose both branches
//    exit, or a try whose body exits and whose finally is absent,
//    empty, or exits): the `else` is redundant — dedent its body. An
//    inner if WITHOUT an else never counts as exiting: control falls
//    through when its condition is false, so dedenting would change
//    behavior (the upstream's own hard-learned trap, encoded in
//    exitsAsIf). `switch` bodies are not analyzed (case fall-through),
//    so a trailing switch never counts.
// 3. Chain after terminal then — an `else if` following an
//    always-exiting then-branch. The whole chain wants a guard
//    sequence or a dispatch table; that rewrite is not mechanical, so
//    this check only points at it (no fix-shaped message). JS spells
//    `else if` as the if's `alternate` being another IfStatement (no
//    distinct node).
//
// JS host notes: `throw` is a statement (Dart's `throw`/`rethrow` are
// expressions), so the jump set is the four jump statements and there
// is no rethrow; labeled statements, loops, and switch bodies are not
// analyzed and therefore never count as exiting (conservative, like
// upstream).
//
// Port conventions (crap4js has no gate framework or config file):
// default-on subcommand, warning severity — findings are printed but
// exit 0 by default; `--severity error` exits 2. Violations honor
// ignore markers (`collapsible-flow` is in IGNORABLE_GATES). Every
// finding is correct code — this gate trades flatness, not bugs.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { childrenOf, parseSource } from './complexity.js';

const GATE_ID = 'collapsible-flow';
const WARNING = 'warning';
const ERROR = 'error';
const SEVERITIES = new Set([WARNING, ERROR]);
const SEVERITY_FLAG = { '--severity': 'severity' };

const IF = 'IfStatement';
const BLOCK = 'BlockStatement';
const TRY_STATEMENT = 'TryStatement';
// `return`/`break`/`continue`/`throw` leave their construct in every
// case (Dart's throw/rethrow expressions map to the JS statement).
const JUMPS = new Set([
  'ReturnStatement',
  'BreakStatement',
  'ContinueStatement',
  'ThrowStatement',
]);

/**
 * Collapsible-flow violations across files. `checked` counts the
 * scanned if statements.
 *
 * @param {string[]} files  absolute source-file paths.
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function collapsibleFlowViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, UTF8);
    const state = {
      file: toRelPath(file, projectRoot),
      violations,
      constructs: 0,
    };
    scanProgram(parseSource(source, path.extname(file)).program, state);
    checked += state.constructs;
  }
  return { violations, checked };
}

// One generic AST walk: every if statement gets its own checks, chain
// links included (an `else if` is itself an if statement).
function scanProgram(program, state) {
  const visit = (node) => {
    if (node.type === IF) {
      state.constructs++;
      checkCollapsibleIf(node, state);
      checkRedundantElse(node, state);
    }
    for (const kid of childrenOf(node)) visit(kid);
  };
  visit(program);
}

// Check 1: `if (a) { if (b) X }` — no `else` on either level, the
// then-branch contains only the inner if.
function checkCollapsibleIf(node, state) {
  if (node.alternate) return;
  const inner = singleInnerIf(node.consequent);
  if (!inner || inner.alternate) return;
  add(state, lineOf(node),
    'nested if can be merged into a single condition with `&&`');
}

// The single inner `if` of a collapsible then-branch: either an
// unbraced if, or a block whose only statement is an if. `null` when
// the branch has any other shape.
function singleInnerIf(then) {
  if (then.type === IF) return then;
  if (then.type === BLOCK && then.body.length === 1
    && then.body[0].type === IF) {
    return then.body[0];
  }
  return null;
}

// Checks 2 and 3: an always-exiting then-branch makes a plain `else`
// redundant (dedent) and turns an `else if` into a chain flattening
// hint.
function checkRedundantElse(node, state) {
  if (!node.alternate || !alwaysExits(node.consequent)) return;
  if (node.alternate.type === IF) {
    add(state, lineOf(node.alternate),
      'else-if follows an always-exiting then branch — flatten the '
      + 'chain into guard clauses or a dispatch table');
  } else {
    add(state, lineOf(node),
      'redundant else after an always-exiting then branch — '
      + 'dedent the else body');
  }
}

// Whether `statement` always exits its enclosing construct (the
// enclosing if/loop/switch/function). Conservative: an if without an
// else falls through and never counts; switch bodies are not analyzed
// (case fall-through), so a trailing switch never counts.
function alwaysExits(statement) {
  if (!statement) return false;
  if (JUMPS.has(statement.type)) return true;
  if (statement.type === BLOCK) return exitsAsBlock(statement);
  if (statement.type === IF) return exitsAsIf(statement);
  if (statement.type === TRY_STATEMENT) return exitsAsTry(statement);
  return false;
}

// A block exits when it is non-empty and its last statement exits.
function exitsAsBlock(block) {
  return block.body.length > 0
    && alwaysExits(block.body[block.body.length - 1]);
}

// An if exits only when both branches exist and both exit — a bare
// `if` falls through when its condition is false.
function exitsAsIf(statement) {
  return Boolean(statement.alternate)
    && alwaysExits(statement.consequent)
    && alwaysExits(statement.alternate);
}

// A try exits when its body exits and its non-empty finally exits (an
// empty finally does not change the flow). Catch handlers are not
// analyzed (upstream parity — body and finalizer decide).
function exitsAsTry(statement) {
  if (!alwaysExits(statement.block)) return false;
  const fin = statement.finalizer;
  return fin == null || fin.body.length === 0
    || alwaysExits(fin.body[fin.body.length - 1]);
}

function add(state, line, message) {
  state.violations.push({ file: state.file, line, message });
}

function lineOf(node) {
  return node.loc.start.line;
}

/**
 * One-line summary: `M if statements checked, no collapsible flow`, or
 * `N collapsible-flow finding(s) (M if statements checked)`.
 */
export function collapsibleFlowSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} if statements checked, no collapsible flow`
    : `${violations} collapsible-flow finding(s) (${checked} if statements checked)`;
}

/**
 * The `collapsible-flow` command body: `--severity error` makes
 * violations fail (exit 2); the default warning severity reports and
 * exits 0. Unknown flags and unknown severity values are usage errors
 * (exit 1).
 */
export function runCollapsibleFlow(argv, ctx) {
  const opts = { severity: WARNING, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, SEVERITY_FLAG);
  }
  if (!SEVERITIES.has(opts.severity)) {
    throw new Error(`--severity must be ${WARNING} or ${ERROR}: ${opts.severity}`);
  }
  const code = runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    collapsibleFlowViolations,
    collapsibleFlowSummary,
    GATE_ID,
  );
  return opts.severity === ERROR ? code : 0;
}
