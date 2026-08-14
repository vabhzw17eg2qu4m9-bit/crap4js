// `weight-of-class` subcommand: fails classes that reveal more data than
// behavior — the ratio of public instance fields to public instance
// members exceeds 0.33. Port of crap4dart's weight_of_class gate (0.5.x).
// Static members are excluded; classes without public instance fields are
// never flagged (data/model classes are legitimate).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gateFiles, toRelPath } from './files.js';
import { runCheck } from './gateCommon.js';
import { childrenOf, isNode, parseSource } from './complexity.js';

const MAX_WEIGHT = 0.33;

const CLASS_TYPES = new Set(['ClassDeclaration', 'ClassExpression']);
// Babel 8 emits ClassProperty/ClassPrivateProperty for fields; the
// PropertyDefinition spelling is accepted for forward compatibility.
const FIELD_TYPES = new Set(['ClassProperty', 'PropertyDefinition']);
const METHOD_TYPES = new Set(['ClassMethod', 'ClassPrivateMethod']);

/**
 * Public-instance data weight for every class declared in a parsed
 * program: public instance fields / public instance members.
 *
 * @param {object} program  parsed Program node.
 * @returns {Array<{name: string, line: number, fields: number, members: number, weight: number}>}
 */
export function classWeights(program) {
  const weights = [];
  const visit = (n) => {
    if (!isNode(n)) return;
    if (CLASS_TYPES.has(n.type)) weights.push(weightOf(n));
    for (const c of childrenOf(n)) visit(c);
  };
  visit(program);
  return weights;
}

function weightOf(cls) {
  const { fields, methods } = countMembers(cls);
  const members = fields + methods;
  return {
    name: cls.id?.name ?? '<anonymous>',
    line: cls.loc.start.line,
    fields,
    members,
    weight: members === 0 ? 0 : fields / members,
  };
}

function countMembers(cls) {
  let fields = 0;
  let methods = 0;
  for (const m of cls.body?.body ?? []) {
    if (m.static) continue;
    if (isPublicField(m)) fields++;
    else if (isConcreteMethod(m)) methods++;
  }
  return { fields, methods };
}

// Public instance field: non-static field with a non-private key.
function isPublicField(m) {
  return FIELD_TYPES.has(m.type) && m.key?.type !== 'PrivateName';
}

// Public instance method: non-static method with a body (constructors and
// TS `declare` members excluded, mirroring the Dart gate's
// non-abstract MethodDeclaration rule).
function isConcreteMethod(m) {
  return METHOD_TYPES.has(m.type) && m.kind !== 'constructor' && Boolean(m.body);
}

/**
 * Weight-of-class violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function weightViolations(files, projectRoot) {
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const ast = parseSource(readFileSync(file, 'utf8'), path.extname(file));
    for (const w of classWeights(ast.program)) {
      checked++;
      if (w.fields > 0 && w.weight > MAX_WEIGHT) {
        violations.push({
          file: toRelPath(file, projectRoot),
          line: w.line,
          message: `${w.name} data weight ${formatWeight(w.weight)} > max ${MAX_WEIGHT}`,
        });
      }
    }
  }
  return { violations, checked };
}

// 0.5 → "0.5", 1 → "1", 0.666… → "0.67".
function formatWeight(w) {
  return w.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
}

/**
 * One-line summary: `N/M classes over weight 0.33` on violations,
 * `M classes within weight 0.33` otherwise.
 */
export function weightSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} classes within weight ${MAX_WEIGHT}`
    : `${violations}/${checked} classes over weight ${MAX_WEIGHT}`;
}

/**
 * The `weight-of-class` command body. Returns exit code 2 iff violations
 * exist.
 */
export function runWeightOfClass(paths, ctx) {
  return runCheck(ctx, gateFiles(paths, ctx.cwd), weightViolations, weightSummary);
}
