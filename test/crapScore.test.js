import test from 'node:test';
import assert from 'node:assert';
import { crapScore } from '../src/crapScore.js';

test('CC=5, coverage=1.0 -> 5.0', () => {
  assert.equal(crapScore(5, 1.0), 5.0);
});

test('CC=5, coverage=0.0 -> 30.0', () => {
  assert.equal(crapScore(5, 0.0), 30.0);
});

test('CC=8, coverage=0.45 -> ~18.648', () => {
  const score = crapScore(8, 0.45);
  assert.ok(Math.abs(score - 18.648) < 0.01, `got ${score}`);
});

test('CC=3, coverage=null -> null', () => {
  assert.equal(crapScore(3, null), null);
});
