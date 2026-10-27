// Shared simple literals used across modules — every constant owns one
// spelling, not one usage: the same value may legitimately play several
// roles (TEST is the default test directory, the node:test registrar and
// the TAP type of a real test). The scattered-constants gate guards
// against the literals reappearing inline elsewhere.

// The `test` name: the default test directory, the node:test registrar
// and the TAP `type:` diagnostic of a real test.
export const TEST = 'test';

// The node test runner's flag (`node --test`).
export const TEST_FLAG = '--test';

// The `--threshold` option name; each command defines what it thresholds.
export const THRESHOLD_FLAG = '--threshold';

// The `coverage` name shared by the coverage flag's value key and the
// coverage output directory skipped as tooling output.
export const COVERAGE = 'coverage';

// The default Istanbul JSON report path, relative to the project root.
export const DEFAULT_COVERAGE = 'coverage/coverage-final.json';

// The shared `exclude` / `ignore` option keys of the gate subcommands;
// `ignore` is also the node child-process stdio discard value.
export const EXCLUDE = 'exclude';
export const IGNORE = 'ignore';

// The `string` spelling — JavaScript's typeof tag and the Babel
// string-token label all spell it identically.
export const STRING = 'string';

// Milliseconds per second — the unit scale factor 1000: seconds to
// millis (mutation timeout), micros to millis and millis to seconds
// (profile report formatting).
export const MILLIS_PER_SECOND = 1000;
