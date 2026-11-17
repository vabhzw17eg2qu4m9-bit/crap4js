// `implicit-state` subcommand: surfaces *implicit finite state machines* —
// lifecycle logic spread over boolean flag clusters, multi-mutator status
// fields and conditions that branch on flag combinations. Port of
// crap4dart's implicit_state gate (upstream spec §11.30, commit
// 34e2163080) with the JS host map:
//
// - Lifecycle-flag name shape: `is/has/was/will/should/can` + Capital
//   (`isLoading`, `hasFailed`) or a lifecycle keyword suffix (`shardLoaded`,
//   `engineReady`, `runPending`). Status field names: exact lowercase match
//   in {status, state, phase, stage, mode, lifecycle} — any field type.
// - Eligibility: mutable non-static instance fields only. Dart's
//   final/const map to TS `readonly`; `static` excluded either way. Plain
//   .js has no types, so the bool requirement is heuristic there: a field
//   initialized to `true`/`false` counts as a lifecycle bool, while
//   .ts/.tsx fields with a `boolean` annotation qualify with or without an
//   initializer. A JS declaration-only field can never prove its type and
//   is not counted (documented divergence from upstream, which reads the
//   declared type).
// - Mutations: `this.flag = ...` and any `obj.flag = ...` member assignment
//   with a matching property name count, whatever the receiver (upstream
//   counts the property-name shape only), inside any member body — named
//   or `#private` methods, getters/setters, constructors included. A BARE
//   `flag = ...` inside a method is not a field write in JS (that spelling
//   is a global/undeclared variable, not implicit this) and does not
//   count — JS has no implicit this for fields; computed targets
//   (`this['flag'] = ...`) and optional-chaining reads (`this?.flag`,
//   OptionalMemberExpression) stay invisible to a name-shape scan. TS ctor
//   parameter properties (`constructor(private flag = false)`) declare no
//   class-body field node and are not counted — upstream ignores Dart's
//   `this.x` ctor-parameter fields the same way.
// - Flag-combination conditions: an `if` condition reading two or more
//   declared flags of the scanned class via `this.flag` (JS own-field reads
//   need the receiver; reads through other objects do not count). Only
//   IfStatement conditions, like upstream — ternaries/loops are not
//   conditions in v1; an `else if` is its own IfStatement and counts.
// - Detection is per class: every class declaration/expression body is
//   scanned independently; nested classes are separate scans.
//
// A cluster of mutable lifecycle bools mutated from several methods behaves
// like a state machine with unmodelled combination states; a `status`/`state`
// field assigned from many places is an FSM whose transitions are scattered;
// `if (this.isLoading && this.hasFailed)` branches on an implicit
// combination. All three make invalid states representable and transitions
// unauditable — the fix is an explicit model (a sealed state object, a
// single `#transition` method). Detection is deliberately syntactic: it
// cannot prove reachability or races, it surfaces candidates for an
// explicit-model refactor.
//
// Port conventions (crap4js has no gate framework or config file):
// default-on subcommand, warning severity — findings are printed but
// exit 0 by default; `--severity error` exits 2. Thresholds flatten to
// `--min-flags`/`--min-mutators` flags (upstream `min_flags`/`min_mutators`
// config keys). Findings honor ignore markers (`implicit-state` is in
// IGNORABLE_GATES). Every finding is a refactor candidate, not a bug —
// this gate trades modelling clarity, like its siblings.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UTF8, gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { childrenOf, parseSource } from './complexity.js';

const GATE_ID = 'implicit-state';
const WARNING = 'warning';
const ERROR = 'error';
const SEVERITIES = new Set([WARNING, ERROR]);
const SEVERITY_FLAG = { '--severity': 'severity' };
const NUMBER_FLAGS = new Set(['--min-flags', '--min-mutators']);

const MIN_FLAGS = 3;
const MIN_MUTATORS = 2;

const CLASS_DECL = 'ClassDeclaration';
const CLASS_EXPR = 'ClassExpression';
const CLASS_METHOD = 'ClassMethod';
const CLASS_PRIVATE_METHOD = 'ClassPrivateMethod';
const CONSTRUCTOR = 'constructor';
const CLASS_PROPERTY = 'ClassProperty';
const CLASS_PRIVATE_PROPERTY = 'ClassPrivateProperty';
const IF = 'IfStatement';
const ASSIGNMENT = 'AssignmentExpression';
const MEMBER = 'MemberExpression';
const IDENT = 'Identifier';
const THIS_EXPRESSION = 'ThisExpression';
const BOOLEAN_LITERAL = 'BooleanLiteral';
const TS_BOOLEAN = 'TSBooleanKeyword';

// Lifecycle-flag shape: `is/has/was/will/should/can` prefixes (`isLoading`,
// `hasFailed`) or a lifecycle keyword suffix in camelCase (`shardLoaded`,
// `engineReady`, `runPending`).
const STATE_FLAG_NAME = new RegExp(
  '^(?:is|has|was|will|should|can)[A-Z]'
  + '|(?:Loaded|Started|Stopped|Disposed|Pending|Ready|Done|Failed'
  + '|Scheduled|Driving|Running|Closed|Opened|Initialized|Connected'
  + '|Completed|Submitted|Finished|Canceled|Cancelled|Active|Busy'
  + '|Alive|Mounted|Broken|Dirty|Locked|Expired|Cached)$',
);

// Whole-name lifecycle stage: `status`, `state`, `phase`, `stage`, `mode`,
// `lifecycle`.
const STATUS_FIELD_NAME = new RegExp('^(?:status|state|phase|stage|mode|lifecycle)$');

/**
 * Implicit-state violations across files. `checked` counts the scanned
 * classes.
 *
 * @param {string[]} files  absolute source-file paths.
 * @param {string} projectRoot
 * @param {{ minFlags?: number, minMutators?: number }} [opts]
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function implicitStateViolations(files, projectRoot, { minFlags = MIN_FLAGS, minMutators = MIN_MUTATORS } = {}) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, UTF8);
    const state = {
      file: toRelPath(file, projectRoot),
      violations,
      minFlags,
      minMutators,
      classes: 0,
    };
    scanProgram(parseSource(source, path.extname(file)).program, state);
    checked += state.classes;
  }
  return { violations, checked };
}

// Program walk: each class gets its own scan (nested classes are separate
// scans, handled inside scanClass).
function scanProgram(program, state) {
  const visit = (node) => {
    if (node.type === CLASS_DECL || node.type === CLASS_EXPR) {
      state.classes++;
      scanClass(node, state);
      return;
    }
    for (const kid of childrenOf(node)) visit(kid);
  };
  visit(program);
}

// One class scan: collects lifecycle flags and status fields, their
// mutation sites per member, and flag-combination conditions. Does not
// descend into nested class bodies — those scan on their own.
function scanClass(cls, state) {
  const scope = { cls, flags: new Map(), statuses: new Map(), memberStack: [] };
  scanBody(cls, cls, state, scope);
  finishClass(cls, state, scope);
}

// Walk one class's subtree, dispatching the node types the gate cares
// about. Nested class nodes scan on their own.
function scanBody(cls, node, state, scope) {
  if (node !== cls && (node.type === CLASS_DECL || node.type === CLASS_EXPR)) {
    state.classes++;
    scanClass(node, state);
    return;
  }
  const handler = NODE_HANDLERS[node.type];
  if (handler && handler(node, state, scope) === SKIP) return;
  for (const kid of childrenOf(node)) scanBody(cls, kid, state, scope);
}

// Sentinel: a handler returns this when it has already descended into the
// node's children itself and the generic child traversal should be skipped
// (the same protocol as complexity.js's parseMethods walk).
const SKIP = Symbol('skip');

// Per-node-type handlers of the class walk. Members attribute their whole
// body (mutations and conditions inside it) to themselves.
const NODE_HANDLERS = {
  [CLASS_PROPERTY]: collectField,
  [CLASS_PRIVATE_PROPERTY]: collectField,
  [CLASS_METHOD]: scanMember,
  [CLASS_PRIVATE_METHOD]: scanMember,
  [ASSIGNMENT]: recordAssignment,
  [IF]: checkCondition,
};

// A member's body attributes to it: push the member name for the walk,
// visit the body, pop.
function scanMember(node, state, scope) {
  scope.memberStack.push(node.kind === CONSTRUCTOR ? '<constructor>' : memberName(node));
  for (const kid of childrenOf(node)) scanBody(scope.cls, kid, state, scope);
  scope.memberStack.pop();
  return SKIP;
}

// Per-field and cluster findings, after the whole class body is visited
// (condition findings above were emitted in traversal order, upstream's
// order).
function finishClass(cls, state, scope) {
  const classLine = cls.loc.start.line;
  reportFields(state, scope.flags, 'lifecycle flag', 'part of an implicit state machine');
  reportFields(state, scope.statuses, 'status field', 'implicit transitions; centralize them');
  reportCluster(state, classLine, scope.flags);
}

// The cluster finding: at least min_flags ASSIGNED flags with at least one
// of them mutated from min_mutators distinct members.
function reportCluster(state, classLine, flags) {
  const assigned = [...flags.values()].filter((sites) => sites.methods.size > 0);
  const scattered = assigned.some((sites) => sites.methods.size >= state.minMutators);
  if (assigned.length < state.minFlags || !scattered) return;
  state.violations.push({
    file: state.file,
    line: classLine,
    message: `class holds ${assigned.length} lifecycle flags mutated across methods — a boolean-cluster state machine; model it with an enum/sealed state`,
  });
}

// Mutable non-static instance fields only: `static` excluded both ways,
// TS `readonly` (Dart's final/const) excluded. Bool evidence: a `boolean`
// annotation (TS only) or a `true`/`false` initializer — plain .js can
// only prove booleans through the initializer.
function collectField(node, state, scope) {
  if (node.static || node.readonly || node.declare) return;
  const name = memberName(node);
  const isBool = node.value?.type === BOOLEAN_LITERAL
    || node.typeAnnotation?.typeAnnotation?.type === TS_BOOLEAN;
  if (isBool && STATE_FLAG_NAME.test(name)) {
    scope.flags.set(name, { line: node.key.loc.start.line, methods: new Set() });
  } else if (STATUS_FIELD_NAME.test(name.toLowerCase())) {
    scope.statuses.set(name, { line: node.key.loc.start.line, methods: new Set() });
  }
}

// The declaration-site name: method/field keys, private `#x` fields carry
// the bare name (the `#` is syntax, not the name).
function memberName(node) {
  const key = node.key;
  if (key.type === IDENT) return key.name;
  if (key.type === 'PrivateName') return key.id?.name ?? '';
  return String(key.value ?? '');
}

// A mutation site: any member assignment `X.flag = ...` whose property name
// matches a declared field counts, from the enclosing member (private
// `this.#flag = ...` included — the collected field carries the bare
// name). Bare targets are not field writes in JS.
function recordAssignment(node, state, scope) {
  if (scope.memberStack.length === 0) return;
  const name = assignedPropertyName(node.left);
  if (name === null) return;
  const member = scope.memberStack[scope.memberStack.length - 1];
  scope.flags.get(name)?.methods.add(member);
  scope.statuses.get(name)?.methods.add(member);
}

// The written property's bare name, or null: any receiver's non-computed
// `.flag = ...` (named or `#private`) counts; bare and computed targets
// are not field writes in JS.
function assignedPropertyName(target) {
  if (target?.type !== MEMBER || target.computed) return null;
  const prop = target.property;
  if (prop?.type === IDENT) return prop.name;
  if (prop?.type === 'PrivateName') return prop.id?.name ?? null;
  return null;
}

// Flag-combination condition: the if's own condition reading two or more
// declared flags via `this.flag` — JS own-field reads need the receiver.
function checkCondition(node, state, scope) {
  const names = conditionFlags(node.test, scope.flags);
  if (names.size < 2) return;
  state.violations.push({
    file: state.file,
    line: node.loc.start.line,
    message: `condition branches on ${names.size} lifecycle flags (${[...names].join(', ')}) — an implicit state combination; model the states explicitly`,
  });
}

// Distinct declared flags the condition reads through `this.`.
function conditionFlags(test, flags) {
  const names = new Set();
  const visit = (n) => {
    const name = ownFlagRead(n, flags);
    if (name !== null) names.add(name);
    for (const kid of childrenOf(n)) visit(kid);
  };
  visit(test);
  return names;
}

// The declared flag this node reads (`this.flag` / `this.#flag`), or null —
// anything else is a read through another object (or not a read at all).
function ownFlagRead(n, flags) {
  if (n.type !== MEMBER || n.computed || n.object?.type !== THIS_EXPRESSION) return null;
  const prop = n.property;
  const name = prop?.type === IDENT ? prop.name
    : prop?.type === 'PrivateName' ? prop.id?.name : null;
  return name !== null && flags.has(name) ? name : null;
}

// Report a single flag/status field mutated from too many distinct members.
function reportFields(state, fields, kind, tail) {
  for (const [name, sites] of fields) {
    const count = sites.methods.size;
    if (count < state.minMutators) continue;
    state.violations.push({
      file: state.file,
      line: sites.line,
      message: `${kind} '${name}' is mutated from ${count} places — ${tail}`,
    });
  }
}

/**
 * One-line summary: `M classes scanned, no implicit state machines`, or
 * `N implicit-state finding(s) (M classes scanned)`.
 */
export function implicitStateSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} classes scanned, no implicit state machines`
    : `${violations} implicit-state finding(s) (${checked} classes scanned)`;
}

/**
 * The `implicit-state` command body: `--severity error` makes violations
 * fail (exit 2); the default warning severity reports and exits 0.
 * `--min-flags`/`--min-mutators` flatten upstream's config keys. Unknown
 * flags and unknown severity values are usage errors (exit 1).
 */
export function runImplicitState(argv, ctx) {
  const opts = { severity: WARNING, minFlags: MIN_FLAGS, minMutators: MIN_MUTATORS, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, { ...SEVERITY_FLAG, '--min-flags': 'minFlags', '--min-mutators': 'minMutators' }, NUMBER_FLAGS);
  }
  if (!SEVERITIES.has(opts.severity)) {
    throw new Error(`--severity must be ${WARNING} or ${ERROR}: ${opts.severity}`);
  }
  const code = runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    (files, root) => implicitStateViolations(files, root, opts),
    implicitStateSummary,
    GATE_ID,
  );
  return opts.severity === ERROR ? code : 0;
}
