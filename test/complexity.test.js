import test from 'node:test';
import assert from 'node:assert';
import { extractMethods, leftName } from '../src/complexity.js';

function find(methods, name) {
  return methods.find((m) => m.name === name);
}

test('2 if + 1 for + 1 ternary + 2 && => 7', () => {
  const src = `
export function mixed(a, b) {
  let r = 0;
  if (a > 0) r++;
  if (b > 0) r++;
  for (let i = 0; i < 10; i++) r += i;
  const c = a > b ? 1 : 0;
  return r + c && a && b;
}
`;
  const methods = extractMethods(src);
  const m = find(methods, 'mixed');
  assert.ok(m, 'mixed method not extracted');
  assert.equal(m.complexity, 7);
});

test('every branch construct counted: while, do-while, for-in, for-of, catch, switch cases', () => {
  const src = `
export function everything(obj) {
  let r = 0;
  while (r < 5) r++;
  do { r++; } while (r < 10);
  for (const k in obj) r++;
  for (const v of [1, 2, 3]) r++;
  try { r--; } catch (e) { r++; }
  switch (r) {
    case 1: r++; break;
    case 2: r++; break;
    default: r++;
  }
  return r;
}
`;
  const methods = extractMethods(src);
  const m = find(methods, 'everything');
  // base 1 + while 1 + do 1 + for-in 1 + for-of 1 + catch 1 + 3 cases = 9
  assert.equal(m.complexity, 9);
});

test('arrow function assigned to a variable is named after the variable', () => {
  const src = `
const helper = (a, b) => {
  if (a && b) return 1;
  return 0;
};
`;
  const methods = extractMethods(src);
  const m = find(methods, 'helper');
  assert.ok(m, 'helper not extracted');
  // base 1 + if 1 + && 1 = 3
  assert.equal(m.complexity, 3);
});

test('class method named ClassName.method and counted', () => {
  const src = `
class Calculator {
  add(a, b) {
    if (a > 0 && b > 0) return a + b;
    return 0;
  }
}
`;
  const methods = extractMethods(src);
  const m = find(methods, 'Calculator.add');
  assert.ok(m, 'Calculator.add not extracted');
  // base 1 + if 1 + && 1 = 3 (single `&&` operator)
  assert.equal(m.complexity, 3);
});

test('constructors are excluded', () => {
  const src = `
class Thing {
  constructor(x) { this.x = x; }
  get() { return this.x; }
}
`;
  const methods = extractMethods(src);
  assert.equal(methods.find((m) => m.name.endsWith('constructor')), undefined);
  assert.ok(find(methods, 'Thing.get'));
});

test('nested named FunctionDeclaration is reported separately, not counted in parent', () => {
  const src = `
function outer() {
  if (true) {}
  function inner() {
    if (false) {}
  }
  return inner;
}
`;
  const methods = extractMethods(src);
  const outer = find(methods, 'outer');
  const inner = find(methods, 'inner');
  assert.ok(outer && inner);
  // outer: base 1 + 1 if (inner's body skipped) = 2
  assert.equal(outer.complexity, 2);
  // inner: base 1 + 1 if = 2
  assert.equal(inner.complexity, 2);
});

test('nested anonymous arrow body counts toward enclosing function', () => {
  const src = `
function outer() {
  const arr = [1, 2, 3].map((x) => {
    if (x > 1) return x;
    return 0;
  });
  return arr;
}
`;
  const methods = extractMethods(src);
  const outer = find(methods, 'outer');
  // base 1 + 1 if (inside anonymous arrow) = 2
  assert.equal(outer.complexity, 2);
});

test('line numbers come from acorn loc', () => {
  const src = `
// comment

export function starts() {
  return 1;
}
`;
  const methods = extractMethods(src);
  const m = find(methods, 'starts');
  assert.equal(m.startLine, 4);
  assert.ok(m.endLine >= m.startLine);
});

test('truly anonymous function literal named <anonymous>', () => {
  const src = `
export default function () {
  if (true) return 1;
  return 0;
}
`;
  const methods = extractMethods(src);
  const m = find(methods, '<anonymous>');
  assert.ok(m);
  assert.equal(m.complexity, 2);
});

test('function assigned to an object property via AssignmentExpression', () => {
  const src = `
let ns = {};
ns.method = function (a) {
  if (a) return 1;
  return 0;
};
`;
  const methods = extractMethods(src);
  const m = find(methods, 'ns.method');
  assert.ok(m, 'ns.method not extracted');
  assert.equal(m.complexity, 2);
});

test('object-literal method shorthand and keyed function Property', () => {
  const src = `
const obj = {
  short(a) { if (a) return 1; return 0; },
  keyed: function (a) { if (a) return 2; return 3; },
};
`;
  const methods = extractMethods(src);
  const short = find(methods, 'short');
  const keyed = find(methods, 'keyed');
  assert.ok(short, 'shorthand property not extracted');
  assert.ok(keyed, 'keyed function property not extracted');
  assert.equal(short.complexity, 2);
  assert.equal(keyed.complexity, 2);
});

// ---------- leftName (pure helper) ----------

test('leftName: Identifier returns its name', () => {
  const id = { type: 'Identifier', name: 'foo' };
  assert.equal(leftName(id), 'foo');
});

test('leftName: null/undefined/non-node returns <anonymous>', () => {
  assert.equal(leftName(null), '<anonymous>');
  assert.equal(leftName(undefined), '<anonymous>');
  assert.equal(leftName({ type: 'Literal', value: 1 }), '<anonymous>');
});

test('leftName: MemberExpression with identifier property', () => {
  // foo.bar  (non-computed)
  const member = {
    type: 'MemberExpression',
    object: { type: 'Identifier', name: 'foo' },
    property: { type: 'Identifier', name: 'bar' },
    computed: false,
  };
  assert.equal(leftName(member), 'foo.bar');
});

test('leftName: MemberExpression with computed Literal property', () => {
  // foo['x']  (computed, literal key)
  const member = {
    type: 'MemberExpression',
    object: { type: 'Identifier', name: 'foo' },
    property: { type: 'Literal', value: 'x' },
    computed: true,
  };
  assert.equal(leftName(member), 'foo.x');
});

test('leftName: nested MemberExpression (a.b.c)', () => {
  const member = {
    type: 'MemberExpression',
    object: {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'a' },
      property: { type: 'Identifier', name: 'b' },
      computed: false,
    },
    property: { type: 'Identifier', name: 'c' },
    computed: false,
  };
  assert.equal(leftName(member), 'a.b.c');
});
