import test from 'node:test';
import assert from 'node:assert';
import { computeCognitive, extractMethods, parseSource } from '../src/complexity.js';

// Cognitive complexity of the single function declared in `source`.
function cognitiveOf(source) {
  const methods = extractMethods(source, { metric: 'cognitive' });
  assert.equal(methods.length, 1, 'expected exactly one method in fixture');
  return methods[0].complexity;
}

// Cognitive complexity with direct computeCognitive options (countLambdas).
function cognitiveOfBody(source, opts) {
  const ast = parseSource(source, '.js');
  return computeCognitive(ast.program.body[0].body, opts);
}

test('linear code scores zero', () => {
  assert.equal(cognitiveOf('function add(a, b) { return a + b; }'), 0);
});

test('a flat if scores one', () => {
  assert.equal(cognitiveOf('function f(x) { if (x > 0) return 1; return 2; }'), 1);
});

test('an if inside a loop pays the nesting penalty (Sonar example)', () => {
  // for = +1, if inside = +1 + nesting 1
  const src = `
function f(max) {
  let total = 0;
  for (let i = 1; i <= max; i++) {
    if (i % 2 === 0) total += i;
  }
  return total;
}
`;
  assert.equal(cognitiveOf(src), 3);
});

test('else-if chains stay flat while nested else pays nesting', () => {
  const chain = cognitiveOf(`
function classify(x) {
  if (x < 0) {
    return 'neg';
  } else if (x === 0) {
    return 'zero';
  } else if (x < 10) {
    return 'small';
  }
  return 'other';
}
`);
  const nested = cognitiveOf(`
function classify(x) {
  if (x < 0) {
    return 'neg';
  } else {
    if (x === 0) {
      return 'zero';
    } else {
      if (x < 10) {
        return 'small';
      }
    }
  }
  return 'other';
}
`);
  assert.equal(chain, 3, 'flat chain: one increment per if');
  assert.equal(nested, 9, 'if +1, else +1, if +2, else +2, if +3');
});

test('logical operator sequences count once per same-operator run', () => {
  assert.equal(
    cognitiveOf('function f(a, b, c) { return a && b && c; }'),
    1,
  );
  assert.equal(
    cognitiveOf('function f(a, b, c) { return a && b || c; }'),
    2,
  );
});

test('catch, switch members each increment', () => {
  assert.equal(
    cognitiveOf(
      'function f(x) { switch (x) { case 1: return "int"; default: return "other"; } }',
    ),
    2,
  );
  assert.equal(
    cognitiveOf(
      'function f(x) { try { return JSON.parse(x); } catch (e) { return 0; } }',
    ),
    1,
  );
});

test('nested ternaries pay nesting on the inner branch', () => {
  assert.equal(
    cognitiveOf('function f(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }'),
    3,
  );
});

test('lambda bodies deepen but the lambda itself never increments', () => {
  // f: if inside the arrow = +1 at depth 1; the arrow adds nothing itself.
  // g: reported as its own entry — its if scores 1 at its own root.
  const methods = extractMethods(
    'function f(a) { const g = (x) => { if (x) return 1; return 2; }; return g(a); }',
    { metric: 'cognitive' },
  );
  assert.equal(methods.find((m) => m.name === 'f').complexity, 2);
  assert.equal(methods.find((m) => m.name === 'g').complexity, 1);
});

test('countLambdas: false skips lambda bodies', () => {
  const src =
    'function f(a) { const g = (x) => { if (x) return 1; return 2; }; return g(a); }';
  assert.equal(cognitiveOfBody(src, { countLambdas: false }), 0);
  assert.equal(cognitiveOfBody(src, { countLambdas: true }), 2);
});

test('nested named function declarations are skipped', () => {
  // f skips g's branches entirely; g is reported as its own entry.
  const methods = extractMethods(
    'function f(a) { function g(x) { if (x) return 1; return 2; } return g(a); }',
    { metric: 'cognitive' },
  );
  assert.equal(methods.find((m) => m.name === 'f').complexity, 0);
  assert.equal(methods.find((m) => m.name === 'g').complexity, 1);
});

test('default metric stays cyclomatic', () => {
  // base 1 + if; cognitive would report just 1.
  const src = 'function f(x) { if (x > 0) return 1; return 2; }';
  assert.equal(extractMethods(src)[0].complexity, 2);
  assert.equal(extractMethods(src, {})[0].complexity, 2);
});
