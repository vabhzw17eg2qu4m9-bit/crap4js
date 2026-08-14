// Tabular CRAP report formatter.
//
// Output shape:
//   CRAP Report
//   ===========
//   <header line of dashes>
//   <one row per method>
//   <blank line>
//   Max CRAP: <max> (threshold <t>) — FAILED|passed
//
// Sorting: numeric CRAP descending; null (N/A) entries last; ties broken by
// (file asc, startLine asc). All-N/A report yields max 0.0 and a "passed" verdict.

const W_METHOD = 30;
const W_FILE = 35;
const W_CC = 4;
const W_COV = 7;
const W_CRAP = 8;

/**
 * Format the metrics array as a CRAP report string.
 *
 * @param {Array<object>} metrics  MethodMetric array (already sorted or not).
 * @param {{threshold?: number, parseFailures?: string[]}} [opts]
 * @returns {string}
 */
export function formatReport(metrics, { threshold, parseFailures } = {}) {
  const t = threshold != null ? threshold : 8.0;
  const sorted = [...metrics].sort(compareMetricsForReport);

  const header =
    padRight('Method', W_METHOD) +
    ' ' +
    padRight('File', W_FILE) +
    ' ' +
    padLeft('CC', W_CC) +
    ' ' +
    padLeft('Cov%', W_COV) +
    ' ' +
    padLeft('CRAP', W_CRAP);
  const separator = '-'.repeat(header.length);

  let out = '';
  out += 'CRAP Report\n';
  out += '===========\n';
  out += header + '\n';
  out += separator + '\n';
  for (const m of sorted) {
    out +=
      padRight(m.methodName, W_METHOD) +
      ' ' +
      padRight(m.file, W_FILE) +
      ' ' +
      padLeft(String(m.complexity), W_CC) +
      ' ' +
      padLeft(formatCoverage(m.coverage), W_COV) +
      ' ' +
      padLeft(formatCrap(m.crapScore), W_CRAP) +
      '\n';
  }

  const max = sorted.reduce(
    (mx, m) => (m.crapScore != null && m.crapScore > mx ? m.crapScore : mx),
    0,
  );
  const verdict = max > t ? 'FAILED' : 'passed';
  out += '\n';
  out += `Max CRAP: ${max.toFixed(1)} (threshold ${t.toFixed(1)}) — ${verdict}\n`;
  out += parseFailureLine(parseFailures);

  return out;
}

function parseFailureLine(parseFailures) {
  if (!parseFailures || parseFailures.length === 0) return '';
  return `Parse failures: ${parseFailures.length} file(s) — see warnings above.\n`;
}

function compareMetricsForReport(a, b) {
  const aNull = a.crapScore == null;
  const bNull = b.crapScore == null;
  if (aNull && bNull) return tieBreakReport(a, b);
  if (aNull) return 1;
  if (bNull) return -1;
  if (b.crapScore !== a.crapScore) return b.crapScore - a.crapScore;
  return tieBreakReport(a, b);
}

function tieBreakReport(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return (a.startLine || 0) - (b.startLine || 0);
}

function formatCoverage(coverage) {
  if (coverage == null) return 'N/A';
  return (coverage * 100).toFixed(1) + '%';
}

function formatCrap(score) {
  if (score == null) return 'N/A';
  return score.toFixed(1);
}

export function padLeft(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

export function padRight(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
