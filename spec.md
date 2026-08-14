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
crap4js skill            Print the crap4js profiling skill for AI agents.
```

The first argument selects a subcommand when it is exactly `profile`,
`file-naming`, `nesting`, `class-size`, `weight-of-class`, `unused-code`,
`unused-files`, `banned-imports`, or `skill`; anything else (flags, paths)
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

If the coverage file does not exist → a warning is printed to stderr and
every method is reported with `N/A` coverage and CRAP.

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
| `2`  | CRAP threshold exceeded (`CRAP threshold exceeded: <max> > <threshold>` on stderr), profile threshold exceeded, or gate-subcommand violations (file-naming, nesting, class-size, weight-of-class, unused-code, unused-files, banned-imports). |

## `--run-tests`

Runs `npx nyc --reporter=json --reporter=text node --test` (with
`npx c8 --reporter=json node --test` as a fallback) in the project root,
generating `coverage/coverage-final.json`, before analyzing. On failure, the
error is printed to stderr and the CLI exits 1.

## Profile

`crap4js profile [--name <pattern>] [--threshold <ms>] [--top <N>] [paths...]`
runs the test suite against instrumented source and reports per-function
timing. Defaults: `--top 20`, threshold off. `--name` is passed to
`node --test --test-name-pattern`.

How it works (port of crap4dart 0.4.0):

1. A temporary copy of the project is created at
   `<root>/.crap_profile_temp/` (inside the project root, so `node_modules`
   resolution walks up to the real dependencies) with `package.json`, `src/`,
   `test/`, and every analyzed source file instrumented in place.
2. Instrumentation wraps every function body — located with the same
   extraction rules as `analyze` — in `performance.now()` + `try/finally`,
   calling `globalThis.__crap_record("<relFile>|<method>", start)`.
3. A collector module is preloaded into every node process via
   `NODE_OPTIONS --import`; it aggregates (calls, totalMicros, minMicros,
   maxMicros) per method and merges into `CRAP_PROFILE_OUTPUT` with atomic
   writes (temp file + rename), so parallel test processes aggregate safely.
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

## Gate subcommands (crap4dart 0.5.x ports)

`nesting`, `class-size`, `weight-of-class`, `unused-code`, `unused-files`,
and `banned-imports` are ports of the crap4dart 0.5.x gates of the same
names. crap4js has no gate framework and no config file, so each gate is
a CLI subcommand with its built-in default thresholds; every gate accepts
`[paths...]` (default: the normal source-selection rules, test files and
test directories always excluded). Shared output contract: one
`file[:line]: message` line per violation, then a one-line summary; exit
codes `0` pass, `1` usage error, `2` violations.

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
