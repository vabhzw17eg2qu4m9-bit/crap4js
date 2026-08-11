import test from 'node:test';
import assert from 'node:assert';
import { coverageForMethod } from '../src/coverage.js';

test('attributes covered/total for statements in range', () => {
  const fileCoverage = {
    statementMap: {
      '0': { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } },
      '1': { start: { line: 6, column: 0 }, end: { line: 6, column: 12 } },
      '2': { start: { line: 7, column: 0 }, end: { line: 7, column: 5 } },
    },
    s: { '0': 3, '1': 0, '2': 1 },
  };
  // method covers lines 5-7: 2 of 3 covered
  assert.equal(coverageForMethod(fileCoverage, 5, 7), 2 / 3);
});

test('partial overlap still intersects (statement crosses boundary)', () => {
  const fileCoverage = {
    statementMap: {
      '0': { start: { line: 4, column: 0 }, end: { line: 6, column: 0 } },
    },
    s: { '0': 2 },
  };
  // method 5-10 intersects statement 4-6
  assert.equal(coverageForMethod(fileCoverage, 5, 10), 1);
});

test('returns null when no statements intersect the range', () => {
  const fileCoverage = {
    statementMap: {
      '0': { start: { line: 100, column: 0 }, end: { line: 100, column: 5 } },
    },
    s: { '0': 5 },
  };
  assert.equal(coverageForMethod(fileCoverage, 5, 10), null);
});

test('returns null when fileCoverage is null or missing statementMap', () => {
  assert.equal(coverageForMethod(null, 1, 10), null);
  assert.equal(coverageForMethod({}, 1, 10), null);
});

test('counts only hit statements as covered', () => {
  const fileCoverage = {
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
      '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 1 } },
    },
    s: { '0': 0, '1': 0 },
  };
  assert.equal(coverageForMethod(fileCoverage, 1, 2), 0);
});
