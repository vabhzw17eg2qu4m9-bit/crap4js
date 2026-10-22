// Shields-style SVG badge rendering — the analog of upstream crap4dart's
// lib/src/report/badge_svg.dart (same plate geometry and palette, so the
// ports' badges are shape-identical). The `memory` command uses it for
// the churn badge; future commands reuse it instead of re-rolling SVG.

// Bright green — at or below the threshold.
const GREEN = '#4c1';
// Yellow — above the threshold but at most twice it.
const YELLOW = '#dfb317';
// Red — more than twice the threshold.
const RED = '#e05d44';

/**
 * Picks the badge color for `value` against `threshold`: at or below
 * green, above it but at most `2 * threshold` yellow, beyond that red.
 *
 * @param {number} value
 * @param {number} threshold
 * @returns {string} CSS hex color
 */
export function badgeColorFor(value, threshold) {
  if (value <= threshold) return GREEN;
  if (value <= 2 * threshold) return YELLOW;
  return RED;
}

function plateWidth(text) {
  return Math.round(text.length * 6.3) + 10;
}

function escapeXml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Renders a flat shields.io-style SVG badge: a grey label plate on the
 * left and a colored message plate on the right.
 *
 * @param {string} label
 * @param {string} message
 * @param {string} colorHex  CSS hex color (e.g. '#4c1')
 * @returns {string} self-contained SVG document
 */
export function renderBadgeSvg(label, message, colorHex) {
  const labelWidth = plateWidth(label);
  const messageWidth = plateWidth(message);
  const totalWidth = labelWidth + messageWidth;
  const labelCenter = labelWidth / 2;
  const messageCenter = labelWidth + messageWidth / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" ` +
    `height="20" viewBox="0 0 ${totalWidth} 20" role="img" ` +
    `aria-label="${escapeXml(label)}: ${escapeXml(message)}">\n` +
    `  <title>${escapeXml(label)}: ${escapeXml(message)}</title>\n` +
    `  <rect width="${labelWidth}" height="20" rx="3" fill="#555"/>\n` +
    `  <rect x="${labelWidth}" width="${messageWidth}" height="20" rx="3" ` +
    `fill="${colorHex}"/>\n` +
    `  <rect width="${totalWidth}" height="20" rx="3" fill="none"/>\n` +
    `  <g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" ` +
    `font-size="11" text-anchor="middle">\n` +
    `    <text x="${labelCenter}" y="14">${escapeXml(label)}</text>\n` +
    `    <text x="${messageCenter}" y="14">${escapeXml(message)}</text>\n` +
    `  </g>\n` +
    `</svg>\n`
  );
}
