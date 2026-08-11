// Expected CC = 2 (base 1 + 1 `if`).
// Expected coverage = 100% when both statements are hit.
// Expected CRAP = 2^2 * 0^3 + 2 = 2.0.
export function addPositive(a, b) {
  if (a < 0) a = 0;
  return a + b;
}

// Expected CC = 1 (no branches).
// Expected CRAP with no coverage = null.
export function identity(x) {
  return x;
}
