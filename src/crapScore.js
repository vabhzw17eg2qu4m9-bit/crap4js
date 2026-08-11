// CRAP (Change Risk Anti-Patterns) metric formula.
//
//   CRAP = CC^2 * (1 - coverage)^3 + CC
//
// where CC is the cyclomatic complexity (integer >= 1) and `coverage` is a
// fraction in [0, 1]. When coverage is unknown (null), the score is null and
// is reported as "N/A".

/**
 * Compute the CRAP score for a single method.
 *
 * @param {number} cc        Cyclomatic complexity (>= 1).
 * @param {number|null} coverage  Statement-coverage fraction in [0, 1], or null.
 * @returns {number|null}    CRAP score, or null when coverage is unknown.
 */
export function crapScore(cc, coverage) {
  if (coverage == null) return null;
  const complexity = Number(cc);
  const uncovered = 1.0 - coverage;
  return complexity * complexity * uncovered * uncovered * uncovered + complexity;
}
