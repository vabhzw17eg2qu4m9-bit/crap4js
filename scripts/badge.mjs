#!/usr/bin/env node
// Zero-dep shields-style SVG badge generator.
// Usage: node scripts/badge.mjs <label> <value> <color> <out.svg>

import { writeFileSync } from 'node:fs';

const [label, value, color, out] = process.argv.slice(2);
if (!label || value == null || !color || !out) {
  console.error('Usage: node scripts/badge.mjs <label> <value> <color> <out.svg>');
  process.exit(1);
}

const esc = (s) =>
  String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
const width = (s) => Math.ceil(String(s).length * 6.5) + 10;

const LW = width(label);
const VW = width(value);
const W = LW + VW;
const labelText = esc(label);
const valueText = esc(value);
const pair = `${labelText}: ${valueText}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="20" viewBox="0 0 ${W} 20" role="img" aria-label="${pair}">
  <title>${pair}</title>
  <rect width="${LW}" height="20" rx="3" fill="#555"/>
  <rect x="${LW}" width="${VW}" height="20" rx="3" fill="${color}"/>
  <rect width="${W}" height="20" rx="3" fill="none"/>
  <g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="${LW / 2}" y="14">${labelText}</text>
    <text x="${LW + VW / 2}" y="14">${valueText}</text>
  </g>
</svg>
`;

writeFileSync(out, svg);
