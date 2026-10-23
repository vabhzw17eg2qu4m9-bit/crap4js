// `inline-anon-types` subcommand: fails inline anonymous type literals in
// function signature annotations — the JS/TS/Flow analog of crap4dart
// 4d844a4's record gates (inline_record_types + record_size, merged):
// Dart records don't exist here, so the honest host-language analog of an
// anonymous record shape is an inline object type literal (`{a: string}`,
// TS TSTypeLiteral / Flow ObjectTypeAnnotation) or an inline tuple type
// (`[string, number]`, TSTupleType / TupleTypeAnnotation) in a parameter
// or return annotation, including nested inside type arguments
// (`Promise<{r: string}>`). Every tuple/object annotation is unnamed by
// nature, so upstream's unnamed-fields kind collapses into this one.
// Positional field access (`.$N`) has no JS analog — universal indexing
// (`t[0]`) would fire on every array — and is skipped.
//
// Named interfaces and type aliases are the blessed form and are not
// flagged (only their *references* appear in signatures). A function-type
// alias blesses nothing, mirroring upstream: the inline shape behind
// `type F = (x: {a: string}) => void` is still flagged.
//
// Plain .js/.jsx without type syntax has nothing to flag — there is no
// JSDoc parsing — so the gate is a documented no-op there; the surface
// exists on .ts/.tsx (already part of the default selection) and on
// flow-annotated .js files. --max-fields (default 5) caps the arity of a
// flagged shape: tuple length / object member count.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gateFiles, toRelPath } from './files.js';
import { applyGateArg, runCheck } from './gateCommon.js';
import { childrenOf, isNode, parseSource } from './complexity.js';

const MAX_FIELDS = 5;

// Anonymous shape spellings: TS object/tuple literals and their Flow names.
const ANON_SHAPE_TYPES = new Set([
  'TSTypeLiteral',
  'TSTupleType',
  'ObjectTypeAnnotation',
  'TupleTypeAnnotation',
]);

// Function-like declarations whose parameter/return annotations form a
// signature (TSDeclareFunction = bodyless overload declaration).
const SIGNATURE_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassMethod',
  'ClassPrivateMethod',
  'ObjectMethod',
  'TSDeclareFunction',
]);

// Type aliases whose aliased type is a function type: scanned like any
// signature (a function-type alias blesses nothing — upstream 4d844a4).
const FUNCTION_TYPE_NODES = new Set(['TSFunctionType', 'FunctionTypeAnnotation']);
const TYPE_ALIAS_TYPES = new Set(['TSTypeAliasDeclaration', 'TypeAlias']);

// The aliased type: `typeAnnotation` on TS aliases, `right` on Flow ones.
function typeAliasInner(n) {
  return n.typeAnnotation ?? n.right;
}

// Member count of a flagged shape: tuple arity / object member count.
function memberCount(shape) {
  const list = shape.members ?? shape.elementTypes ?? shape.properties ?? shape.types;
  return list?.length ?? 0;
}

// Walks a type-annotation subtree reporting the OUTERMOST anonymous shape
// of any nested group — an inner shape inside a flagged one is part of the
// same fix (upstream's _TypeWalker rule). Descent through named references
// reaches shapes nested inside type arguments.
function scanType(node, out) {
  if (ANON_SHAPE_TYPES.has(node.type)) {
    out.push({ members: memberCount(node), line: node.loc.start.line });
    return;
  }
  for (const c of childrenOf(node)) scanType(c, out);
}

// Parameter and return annotations of one signature. Beyond plain params,
// annotations also live on the Identifier inside a default value
// (AssignmentPattern.left) and inside a constructor parameter property
// (TSParameterProperty.parameter).
function annotationRoots(sig) {
  const roots = sig.params
    .map((p) => p.typeAnnotation ?? p.left?.typeAnnotation ?? p.parameter?.typeAnnotation)
    .filter(Boolean);
  if (sig.returnType) roots.push(sig.returnType);
  return roots;
}

function scanSignature(sig, out) {
  for (const root of annotationRoots(sig)) scanType(root, out);
}

/**
 * Inline anonymous shapes in every signature declared in a parsed program.
 * Function bodies are descended for nested functions and class methods.
 *
 * @param {object} program  parsed Program node.
 * @returns {{shapes: Array<{members: number, line: number}>, signatures: number}}
 */
export function signatureShapes(program) {
  const shapes = [];
  let signatures = 0;
  const visit = (n) => {
    if (!isNode(n)) return;
    if (SIGNATURE_TYPES.has(n.type)) {
      signatures++;
      scanSignature(n, shapes);
    } else if (
      TYPE_ALIAS_TYPES.has(n.type) &&
      FUNCTION_TYPE_NODES.has(typeAliasInner(n)?.type)
    ) {
      signatures++;
      scanSignature(typeAliasInner(n), shapes);
    }
    for (const c of childrenOf(n)) visit(c);
  };
  visit(program);
  return { shapes, signatures };
}

/**
 * Inline-anon-types violations across files.
 *
 * @param {string[]} files  absolute paths.
 * @param {string} projectRoot
 * @param {{maxFields?: number}} [opts]
 * @returns {{violations: Array<{file, line, message}>, checked: number}}
 */
export function inlineAnonTypesViolations(files, projectRoot, opts = {}) {
  const maxFields = opts.maxFields ?? MAX_FIELDS;
  const violations = [];
  let checked = 0;
  for (const file of files) {
    const ast = parseSource(readFileSync(file, 'utf8'), path.extname(file));
    const { shapes, signatures } = signatureShapes(ast.program);
    checked += signatures;
    for (const s of shapes) {
      const over =
        s.members > maxFields ? ` — ${s.members} members > max ${maxFields}` : '';
      violations.push({
        file: toRelPath(file, projectRoot),
        line: s.line,
        message: `inline anonymous type in signature (${s.members} member(s)) — declare it as a named interface/type alias${over}`,
      });
    }
  }
  return { violations, checked };
}

/**
 * One-line summary: `N signatures checked, no inline anonymous types` when
 * clean, else the violation count.
 */
export function inlineAnonTypesSummary({ violations, checked }) {
  return violations === 0
    ? `${checked} signatures checked, no inline anonymous types`
    : `${violations} inline anonymous types in signatures`;
}

/**
 * Parse `inline-anon-types` arguments into `{ maxFields, paths }`.
 * `--max-fields` accepts `--flag VALUE` or `--flag=VALUE`; anything else
 * is a path. Unknown flags and invalid numbers are usage errors.
 *
 * @param {string[]} argv
 */
export function parseInlineAnonTypesArgs(argv) {
  const opts = { maxFields: MAX_FIELDS, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    i = applyGateArg(opts, argv[i], argv, i, { '--max-fields': 'maxFields' }, new Set(['--max-fields']));
  }
  return opts;
}

/**
 * The `inline-anon-types` command body. Returns exit code 2 iff violations
 * exist.
 */
export function runInlineAnonTypes(argv, ctx) {
  const opts = parseInlineAnonTypesArgs(argv);
  return runCheck(
    ctx,
    gateFiles(opts.paths, ctx.cwd),
    (fs, root) => inlineAnonTypesViolations(fs, root, opts),
    inlineAnonTypesSummary,
  );
}
