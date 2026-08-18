# crap4js spec

Adapted from the shared crap4{js,go,py} contract. JavaScript-specific scope
and conventions.

## Purpose

Compute the CRAP (Change Risk Anti-Patterns) metric for JavaScript source
code by combining cyclomatic complexity with statement coverage. Identical
formula, complexity rules, CLI contract, report format, and exit codes to
the sibling ports (`crap4java`, `crap4dart`, `crap4go`, `crap4py`).

## Scope

In scope:

- Pure JavaScript (ES2020+), CommonJS (`.cjs`), and ESM (`.mjs`).
- Cyclomatic complexity via `acorn` AST.
- Statement coverage via Istanbul / nyc JSON.
- Class methods, top-level functions, assigned function/arrow expressions.

Out of scope (v1, see *Non-Goals*):

- TypeScript (`.ts`), JSX/TSX, flow typing.
- Branch / function coverage attribution (only statement coverage).

## CLI

```
crap4js                  Analyze all .js/.mjs/.cjs files under src/.
crap4js --changed        Analyze git-changed source files under src/.
crap4js <path>...        Analyze explicit files / directories (expanded).
crap4js --help           Print this help and exit 0.
crap4js --coverage <p>   Override coverage file (default: coverage/coverage-final.json).
crap4js --threshold <n>  Override CRAP threshold (default: 8.0).
crap4js --run-tests      Run the test+coverage suite before analyzing.
crap4js profile [--name <p>] [--threshold <ms>] [--top <N>] [paths...]
                         Run instrumented tests, report per-function timing.
crap4js file-naming [paths...]
                         Flag mechanical file names (generic/numeric stems).
crap4js nesting [paths...]
                         Fail functions whose control-flow nesting exceeds 5.
crap4js class-size [paths...]
                         Fail classes with >25 methods or WMC >80.
crap4js weight-of-class [paths...]
                         Fail classes whose public-instance field ratio >0.33.
crap4js unused-code [paths...]
                         Flag module-private declarations never referenced.
crap4js unused-files [paths...]
                         Flag source files never imported (paths → skip).
crap4js banned-imports [--from GLOB --forbid GLOB --message MSG]... [paths...]
                         Enforce architectural import boundaries.
crap4js magic-constants [paths...]
                         Flag hex colors outside constants and literals
                         repeated 3+ times in one file.
crap4js test-assertions [paths...]
                         Flag test()/it() bodies with zero assertion calls.
crap4js folder-structure
                         Flag src/ directories with loose direct files.
crap4js skill            Print the crap4js profiling skill for AI agents.
```

The first argument selects a subcommand when it is exactly `profile`,
`file-naming`, `nesting`, `class-size`, `weight-of-class`, `unused-code`,
`unused-files`, `banned-imports`, `magic-constants`, `test-assertions`,
`folder-structure`, or `skill`; anything else (flags, paths)
is analyzed as the CRAP command above. `--changed` is mutually exclusive
with explicit paths. Unknown flags are a usage error (exit 1).

## File Selection

- Default: walk `<projectRoot>/src/` for `.js`, `.mjs`, `.cjs`. `node_modules`
  directories are skipped.
- `--changed`: parse `git status --porcelain`; keep modified/added/untracked/
  renamed/copied entries (status letters in `{M, A, R, C, ?}`); skip deletions
  and unchanged lines. Rename `old -> new` is resolved to `new`. Result is
  filtered to source extensions and to paths under `src/`.
- Explicit paths: files are kept verbatim; directories are walked for source
  extensions. Results are deduped and sorted.

## Coverage

Default path: `<projectRoot>/coverage/coverage-final.json` (Istanbul JSON).
Override with `--coverage <path>`.

Structure: `{ "/abs/path.js": { statementMap: { id: { start: {line, column}, end: {line, column} } }, s: { id: hitCount } } }`.

Attribution: for each statement whose `[start.line, end.line]` intersects the
method's `[startLine, endLine]`, count it as covered when `s[id] > 0`.
Coverage = `covered / total` (in `[0, 1]`). If no statements intersect,
coverage and CRAP are `null` (`N/A`).

Absolute file-path keys are relativised against the project root. Entries
outside the project root (e.g. dependency paths) are ignored.

If the coverage file does not exist → a warning is printed to stderr,
including the port's own generation command (`npx c8 --reporter=json
node --test`, crap4dart 0.8.7 hint), and every method is reported with
`N/A` coverage and CRAP.

## JavaScript parsing

`acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })`.

Method entries are produced for:

- `FunctionDeclaration` (named; `<anonymous>` for `export default function () {}`)
- `MethodDefinition` inside a class body — named `ClassName.methodName`
  (or just `methodName` for anonymous classes); `constructor` excluded.
- `VariableDeclarator` whose initialiser is a `FunctionExpression` or
  `ArrowFunctionExpression` — named after the variable.
- `AssignmentExpression` whose right-hand side is a function/arrow — named
  after the assignment target (e.g. `obj.method`).
- Object-literal `Property` whose value is a function/arrow — named after
  the key.

Line numbers come from acorn's `loc` (1-based `start.line` to `end.line`).

## Cyclomatic complexity

Base value `1`, then `+1` for each occurrence of:

- `IfStatement`
- `ForStatement`
- `ForInStatement`, `ForOfStatement`
- `WhileStatement`
- `DoWhileStatement`
- `CatchClause`
- `SwitchCase` (including `default`)
- `ConditionalExpression` (ternary)
- `LogicalExpression` with operator `&&` or `||`

Arrow / anonymous function-literal bodies are descended into and counted
toward the enclosing function. Nested NAMED `FunctionDeclaration`s are NOT
descended into — they are reported as their own entries.

## Formula

```
CRAP = CC^2 * (1 - coverage)^3 + CC
```

Verified edge cases (see `test/crapScore.test.js`):

- `CC=5, coverage=1.0`  → `5.0`
- `CC=5, coverage=0.0`  → `30.0`
- `CC=8, coverage=0.45` → `18.648` (±0.01)
- `CC=3, coverage=null` → `null`

## Report

```
CRAP Report
===========
Method                         File                                  CC    Cov%     CRAP
----------------------------------------------------------------------------------------
methodName                     rel/path.ext                          5   45.0%     18.6
anotherMethod                  rel/other.ext                         2     N/A      N/A

Max CRAP: 18.6 (threshold 8.0) — FAILED
```

- Sort: numeric CRAP descending; `N/A` entries LAST. Ties broken by
  (file asc, startLine asc) for stable output.
- `Cov%` shows percentage with 1 decimal (e.g. `45.0%`) or `N/A`.
- `CRAP` shows 1 decimal or `N/A`.
- After the table, a blank line then a summary line: `Max CRAP: <max>
  (threshold <t>) — FAILED|passed`. When all entries are `N/A`, max is `0.0`
  and the verdict is `passed`.
- Empty selection prints `No JavaScript files to analyze.` and exits 0.

## Threshold

Default `8.0`. Override with `--threshold <num>` (must be a non-negative
number; non-numeric values are a usage error).

The verdict is `FAILED` when the maximum numeric CRAP strictly exceeds the
threshold; otherwise `passed`.

## Exit codes

| Code | Meaning                                                                     |
|------|-----------------------------------------------------------------------------|
| `0`  | Success (including empty selection, or max numeric CRAP ≤ threshold).       |
| `1`  | CLI usage error (bad flag, bad threshold, `--changed` + paths, unreadable, banned-imports rule misuse). |
| `2`  | CRAP threshold exceeded (`CRAP threshold exceeded: <max> > <threshold>` on stderr), profile threshold exceeded, or gate-subcommand violations (file-naming, nesting, class-size, weight-of-class, unused-code, unused-files, banned-imports, magic-constants, test-assertions, folder-structure). |

## `--run-tests`

Runs `npx nyc --reporter=json --reporter=text node --test` (with
`npx c8 --reporter=json node --test` as a fallback) in the project root,
generating `coverage/coverage-final.json`, before analyzing. On failure, the
error is printed to stderr and the CLI exits 1.

## Profile

`crap4js profile [--name <pattern>] [--threshold <ms>] [--top <N>] [paths...]`
runs the test suite against instrumented source and reports per-function
timing. Defaults: `--top 20`, threshold off. `--name` is passed to
`node --test --test-name-pattern`. Positional paths select which tests run:
they are remapped from the project root into the instrumented temp copy and
appended to `node --test` (paths outside the root pass through unchanged) —
running the original, non-instrumented test files would record no timings
(crap4dart 0.9.2 fix). The FULL `src/` set is always instrumented and
attributed, so a narrow test selection never shrinks the report.

How it works (port of crap4dart 0.4.0 / 0.9.x fixes):

1. A temporary copy of the project is created at
   `<root>/.crap_profile_temp/` (inside the project root, so `node_modules`
   resolution walks up to the real dependencies) with `package.json`, `src/`,
   `test/`, and every analyzed source file instrumented in place.
2. Instrumentation wraps every function body — located with the same
   extraction rules as `analyze` — in `performance.now()` + `try/finally`,
   calling `globalThis.__crap_record("<relFile>|<method>", start)`.
3. A collector module is preloaded into every node process via
   `NODE_OPTIONS --import`; it aggregates (calls, totalMicros, minMicros,
   maxMicros) per method, flushes every 5 records, and merges into
   `CRAP_PROFILE_OUTPUT` with atomic writes (per-pid temp file + rename),
   so parallel test processes aggregate safely; the merge read retries
   once around a concurrent rename (0.9.2).
4. `node --test` runs in the temp copy; timings are attributed to the
   analyzer's method inventory by `"<relFile>|<methodName>"` key — unmatched
   entries are ignored. The temp directory is removed afterwards (kept when
   `CRAP_PROFILE_DEBUG` is set).

Console table, sorted by TOTAL descending, limited to top N:

```
Profile Report (N methods, total T.TTms)
TOTAL(ms)      %  CALLS   MEAN(µs)   MAX(µs)  @60fps(ms) METHOD                         FILE:LINE
--------------------------------------------------------------------------------------------------
    18.23  20.8%     31      588.0      4200       35.28 walkForEntries                 src/complexity.js:164
```

- `%` — share of total profiled time; `@60fps(ms)` — mean × 60 (cost if the
  function ran every frame at 60fps).
- MEAN values marked `~` are sub-30µs — the instrumentation wrapper costs
  on the order of a microsecond, so those means are mostly profiler noise;
  read the CALLS/TOTAL deltas for such methods instead (0.9.2).
- The full (untruncated) report is also written to
  `profile-reports/profile-<timestamp>.txt` and `.json`.
- Exit 2 when any method's total exceeds `--threshold` ms; exit 1 when the
  run produced no timing data.

Skipped from upstream: `--tags`/`--exclude-tags` (`node --test` has no tag
concept — use `--name` patterns) and the config-file options (crap4js has no
config system; all knobs are CLI flags).

## File naming

`crap4js file-naming [paths...]` (default: the normal source-selection rules)
flags mechanical file names that indicate code split without a domain
boundary:

- Generic stems (lowercased exact match on the basename without extension):
  `common`, `core`, `general`, `helper`, `helpers`, `misc`, `shared`,
  `stuff`, `temp`, `tmp`, `types`, `util`, `utils`, `utilities`, `utility`,
  `various` → `generic name "X.<ext>" — split by domain instead of
  accumulating unrelated declarations`
- Numeric suffix: `[a-z_][0-9]+$` on the lowercased stem → `numeric suffix in
  "X.<ext>" — split by domain instead of numbered parts (batch1, part2, v2 ...)`
- Allowed-stems whitelist (numeric suffix OK): the upstream crap4dart
  `defaultAllowedStems` (`aes256`, `base64`, `crc32`, `sha256`, `utf8`, ...).

Test files (`*.spec.*`, `*.test.*`, `__tests__/`) and test directories
(`test/`, `tests/`) are always excluded.

Output: one line per violation (relative path + message), then a summary —
`N/M files with mechanical names` on violations, `M files have
domain-meaningful names` otherwise. Exit 2 iff violations exist.

## Gate subcommands (crap4dart ports)

`nesting`, `class-size`, `weight-of-class`, `unused-code`, `unused-files`,
and `banned-imports` are ports of the crap4dart 0.5.x gates of the same
names; `magic-constants` is a port of the crap4dart 0.6.x–0.9.x
magic_constants gate; `test-assertions` and `folder-structure` are ports
of the crap4dart 0.9.x test_assertions and folder_structure gates.
crap4js has no gate framework and no config file, so each gate is
a CLI subcommand with its built-in default thresholds; every gate accepts
`[paths...]` (default: the normal source-selection rules, test files and
test directories always excluded — except `test-assertions`, which checks
test files, and `folder-structure`, which takes no arguments). Shared
output contract: one `file[:line]: message` line per violation, then a
one-line summary; exit codes `0` pass, `1` usage error, `2` violations.

Upstream 0.5.0 gate-framework features that have no crap4js equivalent
and are intentionally NOT ported: `severity`/`ignorable`
(`crap:ignore` suppression comments), per-gate `entries` threshold
overrides, and the violation `baseline` (`--save-baseline`/`--baseline`)
mechanism. crap4js has no YAML config, so gate options are CLI flags.

### nesting

Fails functions whose maximum block nesting level exceeds 5 (default).
The function body counts as level 1; every nested control-flow construct
(`if`, `for`, `while`, `do-while`, `switch`, `try`) adds one level —
including constructs inside arrow/function-literal bodies, which count
toward the enclosing function. Violation: `<name> nesting=N > max 5` at
the function's start line.

### class-size

Fails classes with more than 25 concrete methods or a
weighted-methods-per-class sum (total cyclomatic complexity over all
methods, counted with the same rules as `analyze`) above 80.
Constructors and top-level functions are excluded; methods of nested
classes are attributed to the nested class.

### weight-of-class

Fails classes whose ratio of public instance fields to public instance
members exceeds 0.33. Static and private (`#`) members are excluded;
classes without public instance fields are never flagged.

### unused-code

Flags module-scope declarations never referenced anywhere else in their
module — non-exported function declarations, class declarations, and
`const`/`let`/`var` declarators whose identifier appears nowhere else in
the module (lexical counting on unresolved ASTs). Non-test files only;
declarations AND references are counted on those files, so a helper used
only by tests is flagged. Whole-project check: with explicit paths it
prints `not meaningful for a partial selection — skipped` and exits 0
(crap4dart 0.5.1 behavior — a partial file set yields false positives).

### unused-files

Flags non-test source files never imported by any analyzed non-test file.
Import specifiers are collected from static imports, re-exports, dynamic
`import()`, and `require()`; relative specifiers resolve against the
importing file's directory (exact path, source extensions, `/index.<ext>`;
files only, not directories); bare specifiers are external and never
count. Whole-project check: with explicit paths it prints the partial-
selection skip message and exits 0.

### banned-imports

`--from GLOB --forbid GLOB [--message MSG]` triples, zipped in CLI order
(`--flag=value` also accepted; anything else is a path). For every file
matching a rule's `from` glob, each import whose specifier — or, for
relative imports, its resolved project-relative path — matches any
`forbid` glob is a violation: `import <spec> is banned for <file>` plus
` — <message>` when given. Unbalanced `--from`/`--forbid` counts, extra
`--message`s, unknown flags, and missing values are usage errors
(exit 1). With no rules the command prints `no rules configured` and
passes. Globs: `*` matches within one path segment, `**` across
segments, `?` one character.

### magic-constants

Port of the crap4dart 0.6.x–0.9.x magic_constants gate with the upstream
defaults baked in (min_duplicates=3, min_length=4, hex rule on —
crap4js has no config). Two checks per file: (a) integer literals with
a raw lexeme matching `^0[xX][0-9a-fA-F]{6,8}$` (hex colors) that are
not on a line belonging to a `const` initializer — every line spanned
by the initializer is exempt (the full nested subtree: call arguments,
object elements, nested calls, 0.8.4/8071206) — are reported as
`hex color outside a constant declaration`; (b) numeric (counted by raw
lexeme) and string literals (value length ≥ 4) whose value appears 3+
times in one file — every occurrence is reported as `literal <value>
repeats N times — extract a named constant`. Lines inside a `const`
initializer are exempt from the duplicates check as well (0.8.4).
String literals in identifier positions are never counted (0.7.2
map keys, 0.8.3 index expressions, 0.8.5 switch case labels): an
object/dict property key, a computed member index (`obj['name']`,
including optional chains), or a `switch` case label names a protocol
value (JSON field, channel, enum), not a magic constant. JS adaptation:
template literals with interpolations are skipped entirely;
no-interpolation templates count as strings; JS has no adjacent-string
concatenation, so no merged-value handling is needed. Takes only paths
— any `--flag` argument is a usage error (exit 1).

Upstream changes NOT ported (no crap4js equivalent): crap4dart 0.5.2's
profile part-of fix (Dart-only), 0.6.0's baseline/severity/config knobs
(no gate framework or config file in crap4js), 0.6.1's internal
constants refactor (no behavior change).

Upstream 0.7.1 fixes already satisfied by the JS port (verified with
regression tests): unused-code never stripped declared names from the
reference set — the port counts identifier occurrences per module instead
of removing names from a shared reference set, so cross-class same-module
private access was never affected; unused-files already collected
`export ... from` re-exports as import edges. The 0.8.6 banned-imports
glob-regex caching (compile per pattern, not per file) is likewise
already the port's shape — rules are compiled once per run before the
file loop. The 0.8.7 stable N/A-row ordering (tie-break by file:line)
was already the port's sort contract.

### test-assertions

Port of the crap4dart 0.9.x test_assertions gate with min_assertions=1
baked in, mapped to node:test: flags `test()`/`it()` bodies containing
fewer than one assertion call — a test without assertions compiles, runs
green, and verifies nothing. Violation: `'<label>' has 0 assertion(s) —
a test without assertions verifies nothing` at the registration's line.
Counted assertion calls (lexically anywhere inside the body subtree,
closures included):

- calls through bindings imported from `node:assert`, `assert`,
  `node:assert/strict`, or `assert/strict` — default (`assert(x)`),
  namespace (`assert.equal(...)`), and destructured/renamed named
  imports (`ok(x)`); every export of the assert module is an assertion;
- `t.assert.*` member calls on the test-context parameter (the body
  function's first parameter).

`test.skip`/`it.only` registration forms are checked; body-less forms
(`test.todo('x')`) are skipped; tests nested in `describe()` callbacks
are checked individually. Default file set: `<root>/test/` recursively
plus colocated `*.test.js`/`*.spec.js` under `src/`; explicit paths are
kept verbatim. Summary: `M tests assert their expectations` /
`N/M tests without assertions`. Takes only paths — any `--flag`
argument is a usage error (exit 1).

### folder-structure

Port of the crap4dart 0.9.x folder_structure gate with max_loose_files=0
and the default dir baked in (`src`, the port's source root): flags
directories containing more than zero source files DIRECTLY —
`N loose files directly in src — group them into feature packages
(max 0)`. Only direct children count (non-recursive; every source
extension, test colocates included); files in subdirectories are the
organized form; a missing `src/` checks nothing and passes. Summary:
`M directories organized into packages` / `N directory(ies) with
loose-file sprawl`. Takes no arguments — any argument is a usage error
(exit 1).

### not ported from 0.7–0.9 (no crap4js equivalent)

- `broken_goldens` gate + tofu detector + `goldens-guard` command —
  Flutter PNG golden rendering has no JavaScript equivalent.
- external Checkstyle-XML gate — requires the gate-framework config
  system; crap4js has neither.
- run_tests-by-default (0.9.x upstream behavior change) — breaking for a
  CLI tool; crap4js keeps `--run-tests` opt-in (the pre-commit hook runs
  the bare analyze on staged files, where a full test suite per commit
  is unacceptable).
- pixel-detector tuning commits — same Flutter-goldens-only area.

## skill

`crap4js skill` prints a JavaScript-adapted version of the crap4dart
profiling skill (when to profile, how the instrumentation works, how to read
the report) followed by one line on installing it as an agent skill. Exits 0.

## Non-Goals (v1)

- TypeScript / TSX / JSX support (acorn's `ecmaVersion: 'latest'` will not
  parse TS or JSX; parsing such a file errors out and is reported).
- Branch / function / line-level coverage attribution (only statement
  coverage).
- Configurable source roots (only `src/`).
- Test-runner integration beyond `node --test` (no Jest / Mocha / Vitest
  auto-detection).
- HTML / JSON output formats (text report only).
