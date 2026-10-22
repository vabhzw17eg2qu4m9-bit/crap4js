import test from 'node:test';
import assert from 'node:assert';
import { badgeColorFor, renderBadgeSvg } from '../src/badgeSvg.js';

test('badgeColorFor follows the upstream three-band rule (KILL: threshold logic)', () => {
  // At or below → green; above but at most twice → yellow; beyond → red.
  assert.equal(badgeColorFor(500, 500), '#4c1');
  assert.equal(badgeColorFor(0, 500), '#4c1');
  assert.equal(badgeColorFor(500.1, 500), '#dfb317');
  assert.equal(badgeColorFor(1000, 500), '#dfb317'); // exactly 2× is still yellow
  assert.equal(badgeColorFor(1000.1, 500), '#e05d44');
});

test('renderBadgeSvg renders the shields-style plate geometry (PIN: upstream shape)', () => {
  const svg = renderBadgeSvg('memory churn', '245 MB', '#4c1');
  // Upstream parity: 'memory churn' (12 chars) → 86 px plate, '245 MB'
  // (6 chars) → 48 px plate, total 134×20.
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="134" height="20" viewBox="0 0 134 20" role="img" aria-label="memory churn: 245 MB">/);
  assert.match(svg, /<title>memory churn: 245 MB<\/title>/);
  assert.match(svg, /<rect width="86" height="20" rx="3" fill="#555"\/>/);
  assert.match(svg, /<rect x="86" width="48" height="20" rx="3" fill="#4c1"\/>/);
  assert.match(svg, /<text x="43" y="14">memory churn<\/text>/);
  assert.match(svg, /<text x="110" y="14">245 MB<\/text>/);
});

test('renderBadgeSvg escapes XML specials in label and message', () => {
  const svg = renderBadgeSvg('a<b>&"c"', 'x', '#4c1');
  assert.match(svg, /aria-label="a&lt;b&gt;&amp;&quot;c&quot;: x"/);
  assert.ok(!/<b>/.test(svg));
});
