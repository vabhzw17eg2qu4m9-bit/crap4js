// Fixture source for the end-to-end CLI test that asserts a threshold breach.
// Expected CC = 5 (base 1 + 4 `if`s).
// Coverage shows every statement unhit (0%) → CRAP = 25 * 1 + 5 = 30.0 > 8.0.
export function deepNested(a, b, c, d) {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (d > 0) {
          return 1;
        }
      }
    }
  }
  return 0;
}
