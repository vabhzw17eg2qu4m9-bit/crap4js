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

- JavaScript (ES2020+), CommonJS (`.cjs`), ESM (`.mjs`), JSX, Flow and
  TypeScript (`.ts`, `.tsx`).
- Cyclomatic complexity via the `@babel/parser` AST.
- Statement coverage via Istanbul / nyc JSON.
- Class methods, top-level functions, assigned function/arrow expressions.

Out of scope (v1, see *Non-Goals*):

- Branch / function coverage attribution (only statement coverage).

## CLI

```
crap4js                  Analyze all .js/.jsx/.ts/.tsx/.mjs/.cjs under src/.
crap4js --changed        Analyze git-changed source files under src/.
crap4js <path>...        Analyze explicit files / directories (expanded).
crap4js --help           Print this help and exit 0.
crap4js --coverage <p>   Override coverage file (default: coverage/coverage-final.json).
crap4js --threshold <n>  Override CRAP threshold (default: 8.0).
crap4js --metric <m>     Complexity metric: cyclomatic (default) or cognitive;
                         the chosen value feeds the CRAP formula.
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
crap4js scattered-constants [--min-files N] [--min-length N] [--min-value N]
                         [--ignore VALUE]... [--exclude GLOB]...
                         [--aliases|--no-aliases] [paths...]
                         Flag literals whose value repeats across distinct
                         files; existing const declarations regress
                         immediately, private `const _x = kY;` pure aliases
                         always.
crap4js duplicates [--threshold N] [--min-tokens N] [--min-lines N]
                   [--report percentage|clones] [--ignore-locals]
                   [--ignore-literals] [--ignore-identifiers]
                   [--ignore-imports] [--skip-duplicate-files]
                   [--exclude GLOB]... [--source PATH]... [paths...]
                   Flag duplicated token windows within/across files;
                   clones mode reports one violation per clone group.
crap4js test-assertions [paths...]
                         Flag test()/it() bodies with zero assertion calls.
crap4js inline-anon-types [--max-fields N] [paths...]
                         Flag inline anonymous type literals ({...} / [...])
                         in function signature annotations; plain .js is a
                         no-op there.
crap4js folder-structure
                         Flag src/ directories with loose direct files.
crap4js mutation [--min-score N] [--max-survivors N]
                 [--timeout-seconds N] [--max-mutants N]
                 [--operators CAT]... [--exclude GLOB]... [paths...]
                 Mutate one operator/literal at a time and re-run the
                 test suite per mutant; covered sites only, survivors
                 flagged.
crap4js reorder [--dry-run] [paths...]
                 Rewrite class members into the canonical order
                 (deterministic source transform, not a gate).
crap4js skill            Print the crap4js profiling skill for AI agents.
```

The first argument selects a subcommand when it is exactly `profile`,
`file-naming`, `nesting`, `class-size`, `weight-of-class`, `unused-code`,
`unused-files`, `banned-imports`, `magic-constants`, `scattered-constants`,
`duplicates`, `test-assertions`,
`inline-anon-types`, `folder-structure`, `mutation`, `reorder`, or `skill`; anything else (flags, paths)
is analyzed as the CRAP command above. `--changed` is mutually exclusive
with explicit paths. Unknown flags are a usage error (exit 1).

## File Selection

- Default: walk `<projectRoot>/src/` for `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`
  and `.cjs`. `node_modules` directories are skipped.
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

`parse(source, { sourceType: 'module', allowImportExportEverywhere: true,
allowReturnOutsideFunction: true, errorRecovery: true, plugins })`, where
`plugins` routes on the file extension: `.ts`/`.tsx` select the `typescript`
plugin and every other extension selects `flow`, since `@babel/parser`
refuses to enable both at once. Both routes share the JSX, decorator and
class-property plugins.

Method entries are produced for:

- `FunctionDeclaration` (named; `<anonymous>` for `export default function () {}`)
- `ClassMethod` / `ClassPrivateMethod` inside a class body — named
  `ClassName.methodName` (or just `methodName` for anonymous classes);
  `constructor` excluded.
- `VariableDeclarator` whose initialiser is a `FunctionExpression` or
  `ArrowFunctionExpression` — named after the variable.
- `AssignmentExpression` whose right-hand side is a function/arrow — named
  after the assignment target (e.g. `obj.method`).
- Object-literal `ObjectMethod` (shorthand) and `ObjectProperty` whose value
  is a function/arrow — named after the key when that key is an identifier.
  A computed key counts only when it is a bare identifier,
  and is then read as written: `{ [name]() {} }` is reported as `name`, the
  identifier's own text rather than its value. String and numeric literal
  keys, and computed keys of any other shape, are `<anonymous>`.

Line numbers come from Babel's `loc` (1-based `start.line` to `end.line`).

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

## Complexity metric

`--metric` selects the complexity scoring; the chosen value feeds the CRAP
formula unchanged (`cyclomatic` by default; invalid values are a usage
error). The report's complexity column is labeled `CC` for cyclomatic and
`Cogn` for cognitive.

`cognitive` implements the SonarSource Cognitive Complexity definition
(v1.2) as closely as the JavaScript grammar allows:

- The score starts at `0` (it is not a path count).
- `+1` for each break in the linear flow: `if`, `else if`, `else`, every
  loop kind, `catch`, each `switch` member (`case` and `default`), the
  conditional expression (`?:`), and each *sequence* of identical `&&`/`||`
  operators — `a && b && c` is one sequence (+1), `a && b || c` is two (+2).
- A nesting increment of `+1` per enclosing structural level is added on top
  of the basic increment for every structural construct (everything above
  except the logical operators, which never deepen): an `if` inside a loop
  body scores `2`, in a loop inside an `if` scores `3`, and so on.
- `else if` chains are flat: each chained `if` increments at the depth of
  its originating `if`, so a five-way chain scores 5 — while an `if` inside
  an `else` *block* keeps paying the nesting penalty.
- Lambda (function/arrow expression) bodies deepen one level but the lambda
  itself never increments. Nested NAMED `FunctionDeclaration`s are skipped
  entirely, mirroring cyclomatic.

Upstream mapping: this is crap4dart's `gates.complexity.metric` option;
crap4js has no config file, so the option is a CLI flag (the port's
standard surface for gate options).

## Formula

```
CRAP = CC^2 * (1 - coverage)^3 + CC
```

`CC` is the value of the selected complexity metric (`--metric`): the
cyclomatic path count by default, or the cognitive score. The formula itself
is unchanged.

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

The complexity column is labeled `CC` (cyclomatic, default) or `Cogn`
(`--metric cognitive`).

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
| `2`  | CRAP threshold exceeded (`CRAP threshold exceeded: <max> > <threshold>` on stderr), profile threshold exceeded, or gate-subcommand violations (file-naming, nesting, class-size, weight-of-class, unused-code, unused-files, banned-imports, magic-constants, scattered-constants, duplicates, test-assertions, inline-anon-types, folder-structure). |

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
(crap4dart 0.9.2 fix). Explicit paths are the ONLY selectors handed to
`node --test` — no default suite selector is ever appended alongside them;
bare `node --test` (default whole-suite discovery) runs only when no paths
are given (crap4dart 0.9.3 — N/A for the port: upstream unconditionally
appended a `test` directory selector, which `flutter test` treats as a
selector, profiling the whole suite; `node --test` treats positional paths
as the complete run set, so the port's argv was already exclusive — pinned
by a regression test). The FULL `src/` set is always instrumented and
attributed, so a narrow test selection never shrinks the report.

How it works (port of crap4dart 0.4.0 / 0.9.x fixes):

1. A temporary copy of the project is created at
   `<root>/.crap_profile_temp/` (inside the project root, so `node_modules`
   resolution walks up to the real dependencies) with `package.json`, `src/`,
   `test/`, and every analyzed source file instrumented in place.
2. Instrumentation wraps every function body — located with the same
   extraction rules as `analyze` — in `__crap_enter(key)` on entry plus a
   `try/finally` calling `__crap_exit(key)` on exit.
3. A collector module is preloaded into every node process via
   `NODE_OPTIONS --import`; it keeps a call stack of open calls (one frame
   per `enter`, holding the start time and the nested-call time accrued so
   far), aggregates per method (calls, totalMicros, totalSelfMicros,
   minMicros, maxMicros), and flushes every 5 calls plus at
   `process.on('exit')`. `CRAP_PROFILE_OUTPUT` is a file-name PREFIX:
   every process writes its own `<prefix>.<pid>.json` with its full
   cumulative snapshot (temp file + rename), and the parent merges all
   per-pid files afterwards (counters sum, min/max reduce). Each `node
   --test` child is a separate process, and each exclusively owns its
   file, so near-simultaneous children can never lose each other's
   records — the earlier single shared output file dropped them when two
   children both read the same base and each renamed its own merge over
   the other (a real flake in the 0.9.3 explicit-path e2e scenario; the
   0.9.2 retry-around-rename and the 0.9.5 delta-flush bookkeeping both
   existed to patch that shared file and are gone with it: a process
   rewriting its own cumulative snapshot is exact across any number of
   flushes). Same design as the Go port's per-pid record files.
4. `node --test` runs in the temp copy; timings are attributed to the
   analyzer's method inventory by `"<relFile>|<methodName>"` key — unmatched
   entries are ignored. The temp directory is removed afterwards (kept when
   `CRAP_PROFILE_DEBUG` is set).

Console table, sorted by TOTAL descending, limited to top N:

```
Profile Report (2 methods, total 11.44ms)
     TOTAL       SELF      %  CALLS   MEAN(µs)   MAX(µs)  @60fps(ms) METHOD                         FILE:LINE
-------------------------------------------------------------------------------------------------------------
   11.04ms    10.68ms  96.6%      1    11044.0     11044      662.64 slow                           src/add.js:4
    0.39ms     0.39ms   3.4%   1001       ~0.4       316        0.02 add                            src/add.js:1
```

- TOTAL — inclusive wall time across all calls; SELF — TOTAL minus the
  time of nested instrumented calls that completed while the call was open
  (flamegraph self-time semantics — ranks hot code by actual CPU burn, not
  by how many callers fan out through it); `%` — share of total profiled
  time; `@60fps(ms)` — mean × 60 (cost if the function ran every frame at
  60fps).
- TOTAL, SELF, and the summary-line total render with adaptive units —
  `<1000` → `82.50ms`, `<60s` → `13.89s`, `<60m` → `22.50m`, else `13.89h`
  (always 2 decimals) — so extreme call counts keep the columns compact
  (0.9.5; a plain `50000000.00` blew the column width up).
- The collector's call stack is a single global stack, exactly like
  upstream Dart: on the single-threaded event loop this means an async
  function's TOTAL includes awaits, and SELF follows event-loop nesting,
  not async causality.

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

## Memory

`crap4js memory [--top N] [--format console|json] [--badge PATH]
[--badge-threshold MB] [paths...]` — per-test GC/alloc attribution, port
of crap4dart 3bae178 (upstream spec 4.7, phase 1), hardened per upstream
11551739c8 (phase 2: per-child clocks + unattributed bucket + badge).
Runs the suite under the runtime's GC tracing and attributes GC events
and reclaimed memory to files and tests. Informational only: always exits
0 (1 on usage errors); thresholds and the `memory_pressure` gate come
separately — raw GC counts are machine-dependent, allocated MB are not.

- Runner: `node --trace-gc --test --test-reporter=tap <file>`, one test
  file per sequential child run. node:test already gives every file its
  own process, so the process boundary is the exact file attribution —
  the analog of upstream's isolate-name/dill-index machinery; straggler
  rows cannot cross runs (each child's pipes are read separately and
  rows carry the child pid), so upstream's seq-continuation guard has no
  analog here. Rows of the runner process itself go to the unattributed
  bucket; when the pid discriminator would empty a non-empty row set
  (in-process isolation topology), the rows are kept as test-child rows
  instead of fabricating zero churn. Row parsing accepts both renderings
  of V8's `[%d:%p]` isolate header — glibc and Darwin print `0x…`
  lowercase hex, the Windows CRT bare uppercase hex. TAP spans (ok/
  not-ok + `duration_ms` diagnostics) provide the test windows;
  `type: 'suite'` spans (describe blocks) are windows too but are not
  counted as tests.
- Clocks and trust (the phase-2 semantics, adapted to this runtime):
  trace-gc timestamps count ms since the CHILD process started — every
  file owns its clock, and its zero in wall time is MEASURED from the
  file's own first GC row (stderr streams unbuffered: zero = arrival −
  ts) — the analog of upstream's suite event time marking the
  isolate-clock zero. TAP ok-lines arrive in one buffered burst at child
  exit, so test windows are tiled back from the burst with the real
  `duration_ms` values (tests run sequentially); describe-nested spans
  tile flat, so per-test grain under describe is approximate — the row
  still counts toward its file. Only rows INSIDE a test window are
  trusted: loading rows (module compilation, before the first window),
  teardown rows (after the last), and runner-process rows land in a
  separate UNATTRIBUTED bucket that never pollutes file totals; the
  tiled windows are disjoint, so a shared tile edge attributes to the
  earlier test (the outcome of upstream's narrower-window rule under
  tiling). There is no
  global clock offset to calibrate — phase 1's per-file p90 offset vote
  was the artifact source upstream removed; the per-child zero replaces
  it. `--badge <path>` (+ `--badge-threshold MB`, default 500) writes a
  shields-style `memory churn | <N> MB` SVG of the suite total: green at
  or below the threshold, yellow at most twice it, red beyond.
- Semantics: a `--trace-gc` row exposes the WHOLE heap used before →
  after one collection — V8 exposes no generation split, so upstream's
  new-gen churn / old-gen growth pair collapses to `churnMb`
  (Σ max(0, before − after): reclaimed heap volume, the allocation proxy)
  and `heapGrowthMb` (Σ after − before: signed retained growth, the leak
  suspect). The `pooled:` external-memory column and pause times are
  parsed past, not summed. Totals span every parsed row; suite/test
  totals carry only window-attributed rows — the difference is exactly
  the bucket.
- Allocation volume (ported from crap4dart b7c227d): the report and the
  JSON carry `totalAllocatedMb`, the console headline appends
  `, allocated N MB` when positive, and the churn leaderboard is titled
  "top N by allocation volume (churn MB proxy on node)" with an
  `alloc MB` column. On node `totalAllocatedMb` IS the churn total: V8
  exposes no exact gross allocation counter to an out-of-process
  reporter, so the reclaimed-heap proxy is the documented honest value
  (upstream's Dart engine reports the same proxy; only its Flutter
  engine reads exact bytes from the VM's allocation profile). Upstream's
  `--engine auto|dart|flutter` flag is N/A in this port: node is spawned
  directly by the command (one test file per child), so no
  flag-swallowing middleware sits between the tool and the measured
  runtime — there is no engine whose flags need re-routing.
- Output: console leaderboards (top N by churn, top N by heap growth,
  plus the unattributed line) or `--format json` (stdout stays
  JSON-only, progress on stderr) with `testCount`, `gcCount`,
  `totalChurnMb`, `totalAllocatedMb`, `totalHeapGrowthMb`,
  `unattributedCount`, `unattributedChurnMb`, per-suite and per-test
  entries.
- Churn totals are deterministic at file level (function of the code):
  dogfooding this repo, 382 tests / ~187 GCs / ~197 MB total churn, of
  which ~111 loading/teardown/runner GCs (~55 MB) are unattributed;
  window-attributed file numbers repeat across runs to ~±1% for files
  with real churn (top: `testAssertions.test.js` ~40 MB in both runs);
  sub-MB files can flip a single boundary row between a window and the
  bucket. `badges/memory.svg` tracks the self suite and is refreshed by
  running the command manually — the commit-badges workflow refreshes
  only the CRAP/coverage badges, never memory.svg. Churn is the future
  gate metric, never counts.

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
magic_constants gate; `test-assertions`, `folder-structure`, and
`duplicates` are ports of the crap4dart 0.9.x test_assertions,
folder_structure, and duplication gates; `inline-anon-types` is a port
of the crap4dart 4d844a4 record gates (`inline_record_types` +
`record_size`, merged and adapted); `mutation` is a port of the
crap4dart mutation gate (commit c865ec3); `scattered-constants` is a
port of the crap4dart scattered_constants gate (commit e766d68, v2);
`string-hazards` is a port of the crap4dart string_hazards gate (upstream
spec §11.25, commit 62fec6833e); `identical-branches` is a port of the
crap4dart identical_branches gate (upstream spec §11.26, commit
c6b2425add); `collapsible-flow` is a port of the crap4dart
collapsible_flow gate (upstream spec §11.28, commit 7bdfd64ae1);
`non-null-assertion` is a port of the crap4dart non_null_assertion
gate (upstream spec §11.29, commit e3ad58594c).
crap4js has no gate framework and no config file, so each gate is
a CLI subcommand with its built-in default thresholds; every gate accepts
`[paths...]` (default: the normal source-selection rules, test files and
test directories always excluded — except `test-assertions`, which checks
test files, and `folder-structure`, which selects directories by flag and
takes no paths). Shared
output contract: one `file[:line]: message` line per violation, then a
one-line summary; exit codes `0` pass, `1` usage error, `2` violations.

Upstream 0.5.0 gate-framework features that have no crap4js equivalent
and are intentionally NOT ported: `severity` (warning downgrade),
per-gate `entries` threshold
overrides, and the violation `baseline` (`--save-baseline`/`--baseline`)
mechanism. One exception arrives with the 0.23.0 `string_hazards` port:
its warning default becomes the first warning-default gate here —
findings print but exit 0, `--severity error` exits 2 (see
[string-hazards](#string-hazards)); `identical-branches` inherits the
same severity discipline (same rationale: equivalence only holds for
side-effect-free operands), and `collapsible-flow` adopts it because
every one of its findings is correct code — the gate trades flatness,
not bugs. `non-null-assertion` adopts it too, for the upstream
rationale: on an existing codebase every removed `!` needs a per-site
nullability audit (upstream adopts via the `--save-baseline` ratchet,
which crap4js does not port — the ratchet is a manual discipline, see
[non-null-assertion](#non-null-assertion)). crap4js has no YAML config,
so gate
options are CLI flags.
The ignore-comment suppression system IS ported (crap4dart 8abb64c,
`ignore_filter.dart`) with its per-gate `ignorable` opt-in hard-coded —
crap4js has no config file, so the ignorable set is a registry
(`IGNORABLE_GATES` in `src/ignoreFilter.js`), not a config flag.

### Ignore comments (crap4dart 8abb64c)

The gate subcommands drop violations suppressed by ignore comments
before output and exit-code aggregation, applied at the shared
violation path (`runCheck`, plus `file-naming`'s inline body).
Suppression applies only to gates in the ignorable registry — upstream's
`ignorable: true` config opt-in; a non-ignorable gate is never
suppressed, and unreadable files are never ignored.

Markers (`//` comments only — the JS host adaptation; block comments
are out of scope):

- `// crap:ignore` — legacy blanket: suppresses every ignorable gate on
  the violation line or the line above.
- `// crap:ignore-file` — legacy blanket, file scope: anywhere in the
  first 5 lines suppresses every ignorable gate's violations in the file.
- `// ignore:<gate-id>` — granular, line scope, one gate id per marker:
  suppresses only that gate on the violation line (trailing marker) or
  the line above. A run of stacked whole-line markers directly above the
  code line all apply; the walk stops at the first non-marker line.
- `// ignore-file:<gate-id>` — granular, file scope: within the first
  5 lines it suppresses only that gate file-wide.

Grammar: one id per marker, ending at the next whitespace or `/`
(regex `\/\/\s*ignore:([^\s/]*)`, `\/\/\s*ignore-file:([^\s/]*)`).
Several markers on one line union their ids; an empty id (`// ignore:`)
suppresses every ignorable gate, matching the legacy scope. An id never
matches a rule it does not name — unknown ids and comma-lists
(`// ignore:a,b` carries the single id `a,b`) are silently inert. Gate
ids are the crap4js subcommand names.

Ignorable mapping (upstream family → crap4js gate):

| crap4js gates | markers honored | upstream families |
|---|---|---|
| `banned-imports`, `class-size`, `collapsible-flow`, `duplicates`, `identical-branches`, `inline-anon-types`, `magic-constants`, `nesting`, `non-null-assertion`, `scattered-constants`, `string-hazards`, `test-assertions`, `unused-code`, `weight-of-class` | line + file | `banned_imports`, `class_size`, `collapsible_flow`, `duplication`, `identical_branches`, `inline_record_types`+`record_size`, `magic_constants`, `nesting`, `non_null_assertion`, `scattered_constants`, `string_hazards`, `test_assertions`, `unused_code`, `weight_of_class` |
| `file-naming`, `unused-files` | file only (violations have no line) | `file_naming`, `unused_files` |
| `folder-structure` | none — violations name directories, which no comment addresses | `folder_structure` |
| `mutation` | none — its summary carries the pre-aggregated score, which would desync from the filtered violation list | `mutation` |
| `profile`, `memory`, `similarity`, `skill`, `reorder`, analyze | none — informational or transform commands, not gates | — |

Upstream gate families with no crap4js counterpart (`loc`,
`test_coverage`, `complexity`, `method_size`, `record_named_fields`,
`public_docs`, `hardcoded_strings`, `accessibility`, `golden`,
`broken_goldens`, `external`) are simply not ignorable here.

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

### scattered-constants

Port of the crap4dart scattered_constants gate (commit e766d68, v2) —
the corpus-wide sibling of `magic-constants`: that gate counts in-file
repeats only, so a literal used once per file in K files is invisible to
every per-file gate. The command scans the whole corpus, counts distinct
files per literal value, and distinguishes two findings.

*Constant regression*: the corpus already declares a named `const` with
the value — every hardcoded re-introduction (a bare literal or a
duplicate local `const`, any occurrence count, including the declaring
file) is flagged immediately as `hardcoded <value> duplicates constant
\`NAME\` (file:line) — reference the constant instead of repeating the
literal`; no `--min-files` wait. The first declaration wins when
constants share a value; the winning declaration's own site never flags
itself, while a bare literal next to it in the same file does.

*Scattered literal*: no constant exists yet and the value reached
`--min-files` (default 3) distinct files — one violation per occurrence
(file plus line): `literal <value> repeats in N files (M occurrences) —
extract a shared constant and reference it from every site; verify all
occurrences mean the same thing first`. The gate highlights, intent
stays human — the same value is sometimes coincidence.

Values compare semantically: string literals by value (expression-less
template literals included), numbers by numeric value — digit separators
(`86_400`) do not split a fact (`magic-constants` counts raw lexemes;
this gate does not). Literals never counted: strings shorter than
`--min-length` (default 4), numbers with magnitude at or below
`--min-value` (default 100), map keys, computed member indexes and
switch case labels (the protocol-identifier rule shared with
`magic-constants`), and import/export source specifiers (the JS analog
of upstream's exempt import/export/part/part-of URIs). Interpolated
templates and computed initializers never register as constants; a
`const` whose initializer is a plain string/number literal registers
exactly one const-decl site. The floors and the ignore list bind the
constant corpus too (upstream's `_coincidence`): small ints (exit codes,
pixel codes, cache versions) and ignored values are coincidence by
doctrine — they neither collide in the regression rule nor seed the
registry, and const-decl initializer hits pass through the same
minValue/ignore guards as use-site literals (upstream's original
const-decl bypass surfaced 3-file scatter groups for int 1/2 once the
corpus stopped absorbing small values).

*Pure alias*: a private `const` whose initializer is another constant's
identifier — `const _appName = NAME;` — is flagged as adding a name
without information; the message says to reference the shared constant
directly (`alias \`_appName\` adds no information — reference \`NAME\`
directly`). Public declarations are exempt (re-export shims are a
deliberate API shape), computed initializers are not aliases, and the
rule is switchable with `--aliases`/`--no-aliases` (default on).

`--ignore VALUE` exempts a value permanently: strings by value, numbers
by their decimal form — generic vocabulary whose extraction adds churn
without benefit. Entries containing a `/` are file-path globs instead:
files matching them are exempt entirely (a plain word silences the word,
not a folder). `--exclude GLOB` drops files from the count altogether;
the default `src/` selection already excludes test files — the JS-side
default for upstream's generated + `test/**` exclude globs (crap4js has
no generated-code convention). Flags: `--min-files` (int ≥ 0, default
3), `--min-length`, `--min-value`, repeatable `--ignore`/`--exclude`,
`--aliases`/`--no-aliases` (upstream's `aliases` bool, default true);
`--flag VALUE` and `--flag=VALUE` both accepted, any other argument is a
path. Exit 2 iff violations exist; unknown flags (`--x=y`) and invalid
numbers are usage errors (exit 1).

Adaptation notes: upstream's config surface (`enabled`, `severity`,
`ignorable`, `min_files`, `min_length`, `min_value`, `ignore`,
`exclude`, `aliases`) becomes the flags above — crap4js has no config
file; the gate is default-on as a subcommand. Upstream's `deep_search`
option and the short-lived `scattered_fragments` gate were both removed
again in the same upstream commit (v2) and were never ported. Dart
adjacent-strings merging has no JS analog (no literal juxtaposition), so
no merged-value handling exists. The port reuses `magic-constants'`
protocol-identifier and literal-kind helpers (the JS analog of
upstream's shared literal_locations.dart extraction).

Privacy: upstream flags library-private (`_`-prefixed) Dart constants;
JS has no library privacy, so the port keeps the lexical `_`-prefix
convention — `export const _x = kY` still flags (the underscore, not
the export, is the signal), mirroring how the Dart analyzer treats
library-private declarations regardless of export.

Dogfood (upstream a314b485, warnings 62 → 0): this repo runs the gate
on its own `src/`. The upgraded gate went from 124 warnings on the
pre-port tree (45 regressions + 79 scattered) to 1 documented residue:
shared vocabulary — AST node names (`complexity.js`), source/TS/runnable
extension sets (`files.js`), and CLI/config spellings (`constants.js`:
`test`, `--test`, `--threshold`, `coverage`, the default coverage path,
`exclude`, `ignore`, `string`, the 1000 unit scale) — got one home per
spelling and is referenced at every use site; the mutant verdicts moved
next to the cache that persists them. The residue: mutation's
`DEFAULT_MAX_MUTANTS = 500` coincides with memory's
`DEFAULT_BADGE_THRESHOLD = 500` while naming two different facts (max
mutants per run vs badge churn threshold) — upstream exempts such
coincidences via its `ignore` config; crap4js has none, so the code
comment at the site carries the documentation. The mutator's
`test/src/<base>.test.js` candidate spellings survive as interpolated
templates (not counted).

### duplicates

Port of the crap4dart 0.9.x duplication gate (upstream spec §11.11)
including the per-gate `sources` union (commit dc64e9c) and the CPD-parity
rework (commit d6c3ab6), with upstream defaults baked in (threshold=1,
min_tokens=50, min_lines=5, report=percentage — crap4js has no config):

```
crap4js duplicates [--threshold N] [--min-tokens N] [--min-lines N]
                   [--report percentage|clones] [--ignore-locals]
                   [--ignore-literals] [--ignore-identifiers]
                   [--ignore-imports] [--skip-duplicate-files]
                   [--exclude GLOB]... [--source PATH]... [paths...]
```

Each scanned file is tokenized with @babel/parser through the port's
standard plugin routing (raw lexemes kept, one entry per start line).
Comments are skipped — unlike the analyzer, @babel/parser emits comments
inside its `tokens: true` stream (as bare-string token types), so they
are filtered explicitly along with the EOF sentinel; upstream skips its
CommentToken and synthetic tokens instead. A duplicated block is a token
sequence appearing at least twice, at least `--min-tokens` tokens long
and spanning at least `--min-lines` source lines. Detection indexes
every valid window (first-to-last token line span ≥ min_lines) across
all scanned files together, keyed by the joined window code string — a
string key IS the exact window, so upstream's new token-equality
verification of Rabin-Karp fingerprints (commit d6c3ab6) has no JS
counterpart: collisions cannot arise. Every bucket of two or more window
positions becomes a candidate clone group whose occurrences extend to
the maximal extent they share (the longest common run around the
minTokens window); the reference occurrence is anchored at its own
window and clipped to the common length so it cannot extend against
itself. Accepted groups are non-overlapping, longest first — PMD CPD
Match semantics: candidates from both passes are sorted by length, then
occurrence count, then position, and a group is accepted whole only when
none of its occurrences overlaps an already accepted range. Because the
shared extent grows leftward through preceding tokens, a repeated block
usually drags the preceding line's final `;` into a marked window — same
as upstream.

`--report` selects the violation style: `percentage` (the default) fails
each file whose distinct duplicated lines exceed `--threshold` percent
of its total lines (upstream newline count: newline total, +1 for a
trailing fragment); the violation line is the first duplicated line and
the message is `X.XX% duplicated lines > T%`. Only accepted groups mark
lines — an overlapping shorter clone no longer inflates a file's
percent. `clones` (PMD CPD style) fails once per accepted group with
every occurrence location in the message:
`clone: N tokens / M lines, K occurrences: rel:startLine-endLine; ...`,
at most three locations inline and `(+L more)` for the rest; the
violation file/line is the reference occurrence's first line.

Optional normalizations (upstream reads the same knobs as flat YAML keys
under the duplication gate — crap4js has no config, so they are
kebab-case CLI flags):

- `--ignore-locals`: identifiers declared inside a function — parameters
  (except TS parameter properties, which reference API state, matching
  upstream's `this.x` field-formal exclusion), local variables, loop and
  catch variables, type parameters, locally declared functions, and
  pattern/destructuring bindings — are renamed to `$L1`, `$L2`, ...
  placeholders in first-use order before hashing, with one scope per
  outermost method/constructor/function and nested functions sharing the
  outermost scope (no inner-scope shadow tracking, like upstream).
  Renamed clones hash identically, while locals swapped against each
  other keep different placeholders and never match. The API surface —
  called method names, type names, field references — keeps its lexeme.
  Interpolation: upstream masks Dart's whole STRING_INTERPOLATION token
  opaque in this mode; babel's stream is finer-grained — template static
  text arrives as opaque constant chunks and the embedded identifiers are
  renamed like any other local, so the same clones match without a
  separate `$STR` rule.
- `--ignore-literals`: string and numeric literal tokens are replaced
  with `$STR`/`$NUM` placeholders before hashing.
- `--ignore-identifiers` (commit d6c3ab6): every identifier-shaped token
  collapses to one `$ID` placeholder before hashing (CPD
  `--ignore-identifiers`, structure-only matching). babel labels
  contextual keywords (`async`, `of`, `from`, `as`, `get`, ...) as plain
  `name` tokens, so they are masked too — the JS analog of upstream's
  built-in/pseudo keyword slots — along with `#private` names; real
  keywords keep their lexeme. The mask runs after the literal mask and
  before local renaming (which it subsumes), matching upstream's
  precedence.
- `--ignore-imports` (commit d6c3ab6): import/export directives and
  CommonJS `require()` calls (a CJS import) are excluded from
  tokenization; upstream masks `import`/`export`/`part`, which in JS wrap
  code, so a wrapping `export`/`export default` drops only its keywords
  and a brace re-export (`export { a, b } [from '...']`) drops whole.
- `--skip-duplicate-files` (commit d6c3ab6): a file whose token stream
  equals an earlier file's — compared by masked value, so copies
  differing only in comments count too — is skipped from the scan after
  the minTokens floor (CPD `--skip-duplicate-files`): a copied file is
  reported once, not as N x N pairs.

With the knobs off the gate reports exact copy-paste only (the default
scan path is untouched). Detection is a union of two passes (upstream
94299e0): when `--ignore-locals` is on, the raw-lexeme pass runs
alongside the masked one and their candidates compete in one greedy
selection — placeholders are numbered first-use-per-scope, so exact
copies are never lost when enclosing scopes shift the numbering, and a
longer renamed clone wins over the shorter exact copy it contains; the
knobs can only add findings.

Scan set: the standard gate selection (explicit paths or the default
`src/` walk) unioned with every `--source` path — files with a source
extension taken directly, directories walked recursively, missing paths
skipped silently (commit dc64e9c) — filtered by the port's standard
test-file/test-directory exclusion (standing in for upstream's default
`test/**` exclude glob) and by `--exclude` globs, matched against
project-relative POSIX paths with the banned-imports `*`/`**`/`?`
semantics. Upstream's default generated-file excludes (`**.g.dart`,
`**.freezed.dart`, `**.mocks.dart`) have no JavaScript convention to
map to and are not ported. Files with fewer than `--min-tokens` tokens
are skipped from the scan; the summary counts only tokenized files —
percentage mode: `N files, X.XX% duplicated lines` on pass, `M/N files
over T% duplication` on fail; clones mode (upstream 0f54f0d): `no clones
>= L lines across N files, X.XX% duplicated lines` on pass, `K clone
groups (>= T tokens, >= L lines), X.XX% duplicated lines` on fail, where
X.XX is the same project-wide duplicated-line percent the percentage
mode computes.
Exit 2 iff violations exist.

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

The body is the first FUNCTION argument, so metadata can never hide or
fake it: node:test accepts options on either side of the body —
`test('n', fn, {skip: true})` and `test('n', {skip: true}, fn)` — and a
trailing options object is never mistaken for the body (crap4dart 0.9.4
fix; upstream had picked the LAST argument as the body).

`test.skip`/`it.only` registration forms are checked; body-less forms
(`test.todo('x')`) are skipped; tests nested in `describe()` callbacks
are checked individually. Default file set: `<root>/test/` recursively
plus colocated `*.test.js`/`*.spec.js` under `src/`; explicit paths are
kept verbatim. Summary: `M tests assert their expectations` /
`N/M tests without assertions`. Takes only paths — any `--flag`
argument is a usage error (exit 1).

### inline-anon-types

Port of the crap4dart 4d844a4 record gates (`inline_record_types` +
`record_size`, merged and adapted) to JS/TS/Flow: flags inline anonymous
type literals — `TSTypeLiteral`/`TSTupleType` (TypeScript) and
`ObjectTypeAnnotation`/`TupleTypeAnnotation` (Flow) — reachable from a
signature's parameter or return annotations, including nested inside
type arguments (`Promise<{r: string}>`). Signatures: function
declarations, function expressions, arrows, class/object methods,
`declare function` overloads, type aliases whose aliased type is a
function type (a function-type alias blesses nothing — upstream rule;
Flow spellings `TypeAlias`/`FunctionTypeAnnotation` included), and
parameter annotations wherever Babel stores them — plain params,
default-valued params (`AssignmentPattern.left`), and constructor
parameter properties (`TSParameterProperty.parameter`).
Violation: `inline anonymous type in signature (N member(s)) — declare
it as a named interface/type alias`, plus ` — N members > max M` when
the shape's own arity (tuple length / object member count) exceeds
`--max-fields` (default 5; `--flag=VALUE` accepted; any other argument
is a path). Only the outermost shape of a nested group is reported
(upstream's _TypeWalker rule) — an inner shape is part of the same fix.
Named interfaces and type aliases are the blessed form and never
flagged. Adaptation note: Dart records don't exist here — every
tuple/object annotation is unnamed by nature, so upstream's
unnamed-fields kind collapses into the inline kind, and positional
field access (`.$N`) has no honest analog (`t[0]` is universal array
indexing), so that kind is skipped. Plain `.js`/`.jsx` without type
syntax is a documented no-op (no JSDoc parsing); the surface exists on
`.ts`/`.tsx` (part of the default selection) and flow-annotated `.js`.
Summary: `M signatures checked, no inline anonymous types` / `N inline
anonymous types in signatures`. Exit 2 iff violations exist.

### folder-structure

Port of the crap4dart folder_structure gate (commit 753c3580). Flags
directories holding more than their cap of logical source units
DIRECTLY — a flat-file sprawl that should be organized into feature
packages. Only a directory's OWN contents count (non-recursive; every
source extension, test colocates included) — files in subdirectories
are the organized form and never reach the parent's budget; a missing
directory checks nothing and passes. Violation: `N loose files directly
in DIR — group them into feature packages (max CAP)`. Summary:
`M directories organized into packages` / `N directory(ies) with
loose-file sprawl`.

Two configuration shapes, mapped from upstream's YAML `dirs`/
`max_loose_files`/`config` keys to flags:

- **Classic** (default `--dir src`, `--max-loose-files 0`): every
  repeatable `--dir GLOB` entry — a literal path or a glob pattern
  (`src/*`, `packages/**`) expanding to every matching directory —
  shares one `--max-loose-files N` cap. With no `--dir` flags the
  default `src` (the port's source root) applies.
- **Per-pattern caps**: repeatable `--cap PATTERN:N` entries are
  upstream's `config` map (`--cap 'src:3' --cap 'src/**:30'` — a
  registry folder may hold more than a hot core directory). When any
  `--cap` is present it takes precedence and `--dir`/`--max-loose-files`
  are not consulted. A directory matched by several caps uses the FIRST
  cap's value (flag order). Non-integer caps are usage errors (exit 1).

Counting rules: generated siblings of one source file collapse into a
single logical unit — the js-idiomatic suffix set `.d.ts` (declaration
files) and `.min.js` (minified bundles): `magic.js`, `magic.d.ts` and
`magic.min.js` share the stem `magic` and count once (upstream's dart
set is `.g.dart`/`.freezed.dart`; everything else, e.g. `foo.g.js`,
counts as its own unit). `--exclude GLOB` (repeatable, matched on the
project-relative path) drops files from the count. Glob expansion never
enumerates hidden entries (dot-prefixed: `.git`, `.idea`, ...) or build
and tooling output (`node_modules`, `build`, `dist`, `coverage`).
Positional arguments stay a usage error — directories are selected by
flag, not by path (exit 1). With no flags the verdict on ordinary
source trees matches the pre-flag version (default `src`, cap 0); stem
collapse is unconditional, so a directory holding generated siblings of
one file counts fewer logical units than the old raw-file count. Exit 2
iff violations exist.

### mutation

Port of the crap4dart mutation gate (commit c865ec3), adapted from the
unclebob/mutator research conclusions. A declarative, category-tagged
operator table is matched on the parsed babel AST; replacement spans come
from node/token offsets, never regex:

- `arithmetic`: `+`↔`-`, `*`↔`/`, `/`→`%` (upstream's `/`→`~/` is Dart
  integer division; modulo is the JS analog)
- `boundary`: `>`↔`>=`, `<`↔`<=`, `>`↔`<`, `>=`↔`<=`
- `equality`: `==`↔`!=` plus the JS-only strict pair `===`↔`!==`
- `logical`: `&&`↔`||` (matched on `LogicalExpression` where babel keeps
  them, `BinaryExpression` elsewhere)
- `boolean`: `true`↔`false`
- `constant`: integer `0`↔`1` (bare lexemes only — `0x0`, `1.0`,
  `1_000` never mutate), `-1`→`0` over the whole span, with the `1`
  operand yielding its own site like upstream
- `unary`: delete a `!` prefix; prefix expressions only (the postfix TS
  non-null `!` must not corrupt its operand)

One table row at one location is one mutation site
`{file, line, method, category, original, mutant}`; the gate scans the
normal gate file selection (test files/directories always excluded) plus
`--exclude` globs matched project-relatively.

A site is COVERED when its containing method was executed in the
Istanbul coverage data (`coverage/coverage-final.json`, overridable with
`--coverage`) and the site's line is not recorded as unexecuted; sites
outside every method fall back to raw line coverage. Uncovered sites are
excluded from the score denominator and never executed. Every covered
site is mutated one at a time (one textual replacement at its exact
span) and the project's test suite re-runs against it (`node --test` in
the project root — the analog of upstream's `dart test`; the runner
environment strips the enclosing run's `NODE_TEST_CONTEXT` so a nested
runner cannot mistake itself for a test child). A non-zero exit kills
the mutant; a module-load failure is killed the same way, because the
suite refuses to run — the JS analog of upstream's compile-error kill. A
timeout counts as survived: the suite did not kill the mutant
deterministically. The file is restored after every mutant, also after
timeouts and errors. An end-of-run tree integrity check (port of
crap4dart 8b2e8e8) snapshots every file it will mutate before the loop
and re-verifies the whole tree in an outer finally: any file whose
on-disk content drifted from its snapshot (an out-of-band write
defeating the per-site restore — external edit, killed process) is
re-restored AND surfaced as an `INTEGRITY` violation in the summary
(`; INTEGRITY: re-restored after run: src/x.js`) plus a stderr warning;
the tree is healed, but the run must be treated as suspect.

The mutation score is `killed / (killed + survived)`. The gate fails when
the score is below `--min-score` (default 0.8) or when more than
`--max-survivors` (default 0) mutants survive, and reports one
`file:line` violation per survivor (`survived constant mutant \`0\` ->
\`1\` in sign`), so diff mode and baseline conventions apply unchanged.
`--timeout-seconds` (default 60) bounds each mutant run;
`--max-mutants` (default 500) caps the executed sites deterministically
(file order, then offset). Without coverage data or without a `test/`
directory the gate skips itself (exit 0). Expensive — the suite runs
once per mutant — so it only runs when invoked as the `mutation`
subcommand, which is the port's form of upstream's disabled-by-default.

**Digest-incremental cache + test_args** (port of crap4dart 16d9c4c):
`.crap-mutation-cache.json` at the project root (gitignored) stores
per-method outcomes keyed by `rel/path#methodName` and the FNV-1a digest
of the method's exact source text. A killed mutant of an UNCHANGED method
is replayed from the cache (counted killed, reported as `N cached` in
the summary) instead of re-executed; survivors and timeouts always
re-execute (the suite may have improved), and coverage gating is
re-derived from fresh coverage every run. Site offsets are stored
method-relative, so an edit in an earlier method of the same file
invalidates only that method. The envelope carries a meta fingerprint —
tool version (`crap4js <version>`), sorted enabled operators, joined
`test_args` — and any mismatch, corrupt file, or envelope-version change
wipes the cache into a full re-execution. Flags: `--cache`/`--no-cache`
(default: cache on) and `--test-args ARG` (repeatable, values append to
the default `--test`) scope the per-mutant invocation
(`node <test-args...>`) — strict validation (non-empty list of non-empty
strings); scoping the suite is the consumer's responsibility, since a
mutant counts as killed only if the scoped suite would kill it.

**Diff-scoped execution + scope_tests** (port of crap4dart 8228585,
upstream spec §11.22). Under `--diff-base REF` the gate computes the
changed lines vs the ref (`git diff -U0 REF` over the scanned paths,
fixed argv; a git failure — not a repository, unknown ref — is a usage
error, exit 1) and intersects the candidate sites with the changed lines
BEFORE executing: method-level, a site runs only when its containing
method intersects the diff (sites outside every method fall back to
their own line); everything outside the diff is not a mutant of this
change and is neither executed nor counted — per-PR runs pay only for
the mutants of the changed methods. `--scope-tests` (default off)
narrows each mutant's invocation to the derived test file(s) of the
mutated file (`src/foo/bar.js` → `test/src/foo/bar.test.js` and
`test/foo/bar.test.js`, whichever exist), falling back to the full
invocation when no candidate exists. A scoped invocation is a subset of
the full suite, so a scoped KILL is monotone — the full suite kills that
mutant too — and is cached as a regular kill (scope_tests is
deliberately NOT part of the cache meta fingerprint; cached kills stay
valid no matter how the invocation was scoped). A scoped survivor —
timeout included — is NOT monotone (the scoped run may omit the killing
test), so it is re-confirmed ONCE against the full invocation and only
the confirmed outcome is reported and cached. The mutant test runner
receives the resolved per-site invocation arguments; the summary appends
`; test-scoped N (M re-confirmed killed)` when scoping ran.

### similarity

Port of the crap4dart 0.15.0 similarity engine and command (upstream
spec §11.23, commit 2b21966), parser-free and language-agnostic:

```
crap4js similarity [--format console|json] [--jaccard N]
                   [--containment N] [--min-shingles N]
                   [--include GLOB]... [--exclude GLOB]... [paths...]
```

Each scanned file is normalized by its extension profile before any
comparison. `markdown` (`.md`, `.markdown`, `.mdx`) drops fenced code
blocks (``` / ~~~ toggling, both markers interchangeable) and keeps the
trimmed prose lines joined with spaces; single characters and punctuation
drop out at tokenization. `code` (25 source extensions from `.dart` to
`.sql`) strips block comments line-wise (an unterminated `/*` carries
across lines; text after a closing `*/` re-joins), drops line comments
(`//`, `#`, `--`, `;`) and import-family lines (`import`/`export`/
`part`/`library`, `from`/`require`/`require_once`/`using`/`package`/
`include`, shebangs), then tokenizes to identifiers (lowercased) and
quoted strings/numbers mapped to the `S`/`N` placeholders — clones
differing only in literal values still match. Any other extension is
`raw`: content passes through, compared with the prose word tokenizer
(latin+cyrillic runs of 2+ characters, lowercased). One profile per
file, exactly upstream: no JS-specific parser is involved, so the same
scan covers mixed-language corpora.

Shingles are 8 consecutive comparison tokens joined with the unit
separator (upstream's `\u001f`); files with fewer than 8 tokens produce
no shingles and are skipped as `skipped` once below `--min-shingles`
(default 50). Pairs are compared by Jaccard (intersection over union)
and containment (intersection over the smaller set): a pair crosses when
EITHER metric meets its threshold (`--jaccard` 0.8, `--containment` 0.95
— the upstream gate template defaults; containment catches a small file
largely copied into a big one, where Jaccard stays low). Crossing pairs
sort by Jaccard descending; transitive closure over the pairs (union-find
with path compression upstream, plain find here — same clusters) merges
them into clusters of 2+ files, largest first. `metricsFor` reports each
file's strongest (highest-Jaccard) pair metrics for the per-file console
lines.

Scan set: `dirs` (default `['.']`) walked recursively, include globs
(default `**/*.md`) and exclude globs (default `.git/**`,
`node_modules/**`, `build/**`, `coverage/**` — upstream's list minus
`.dart_tool/**`, which has no JS counterpart) matched against
project-relative paths. Positional paths override the dirs: one existing
directory becomes the scan root itself (`dirs: ['.']`), several paths
are subdirectories of the project root, none uses the defaults —
upstream's `_scanTargets` semantics. Upstream reads the same knobs as
flat YAML keys under the similarity gate — crap4js has no config, so
they are kebab-case CLI flags; unknown/invalid values are usage errors
(exit 1), mirroring the upstream loader's strict validation.

Upstream ships this as an opt-in config gate (`enabled: false`,
violations fail `check` with exit 2) PLUS the ad-hoc `similarity`
command (always exit 0). crap4js has no gate framework or check
pipeline — every gate here is a subcommand — so the port is the
command: informational only, ALWAYS exits 0, clean or dirty; the
one-violation-per-clustered-file gate rendering has no separate surface
(the console cluster listing carries the same per-file metrics). Console
output: a `similarity: N files scanned (M skipped below K shingles),
thresholds jaccard >= J / containment >= C` header, then either
`no similar files` or one `cluster i — F files:` block listing each file
as `path (jaccard X.XX, containment Y.YY)`, then the
`F files in C clusters` summary. `--format json` prints
`{scanned, skipped, thresholds: {jaccard, containment, min_shingles},
pairs: [{a, b, jaccard, containment}], clusters: [{files}]}` with pair
metrics rounded to 4 decimals and stdout kept JSON-only.

Dogfooding matches upstream: the port's own md corpus (README, spec,
CHANGELOG) measures clean at jaccard 0.6 / containment 0.9 and still at
0.5/0.85.

### string-hazards

`crap4js string-hazards [--severity warning|error] [paths...]` (port of
the crap4dart string_hazards gate, upstream spec §11.25, commit
62fec6833e) flags string literals whose escaping or pattern usage
contradicts what the author almost certainly meant, from the parsed
AST only. Three finding kinds, with the JS host mapping:

1. **Escaped interpolation** — inside a template literal, a `\$` followed
   by an identifier (optionally brace-enclosed: `\${name}`) renders the
   literal text `$name`. The gate flags such an occurrence only when the
   same ROOT identifier is genuinely interpolated elsewhere in the same
   file (sibling-interpolation evidence); otherwise the escape is
   presumed deliberate (shell text, prices). Root of an interpolated
   expression: `user.name` → `user`, `a.b.c` → `a`,
   `builder.build()` → `builder`; computed member access (`list[0]`) and
   bare calls (`g()`) provide no root, like upstream's index/call
   expressions. Violations dedupe per (line, identifier). JS omissions,
   documented: plain `'...'` strings never interpolate, so they are not
   scanned (Dart's non-raw strings do interpolate); tagged templates
   (`String.raw` and friends) are out of scope, like upstream's raw
   strings.
2. **RegExp source with an escaped anchor** — a regex literal `/...\$/`
   or the first string argument of `RegExp(...)` / `new RegExp(...)`
   ending with `\$` or starting with `\^`. The check reads the regex
   SOURCE — for string arguments the decoded value (`'...\\$'` survives
   into the regex as `\$`), for regex literals the pattern text — so a
   plain `$`/`^` stays an anchor and only the escaped form flags.
   Non-literal arguments are skipped.
3. **Anchors in literal String patterns** — a string literal passed as
   the first argument of a receiver call `x.replace` / `x.replaceAll` /
   `x.split` (String patterns match literally) whose text starts with
   `^` or ends with an unescaped `$`. Bare `split(...)` calls without a
   receiver are out of scope (upstream: `target == null`). The escaped
   trailing form is spared via the raw source text — `'abc\$'` shows
   dollar awareness, `'abc$'` flags (the JS analog of upstream's
   raw-vs-escaped trailing-`$` distinction). Dart's adjacent-strings
   part scan has no JS analog (no literal juxtaposition;
   `'a' + 'b$'` arguments are non-literal and skipped), matching the
   magic-constants precedent.

Upstream's `replaceFirstMapped` / `replaceAllMapped` have no JS analog;
`replace` covers the replace family. Severity: **warning by default** —
findings are printed but exit 0 (upstream's warning severity has no
gate-framework counterpart in crap4js; this is the port's first
warning-default gate, consistent with the go/py ports);
`--severity error` exits 2. Unknown `--flag=...` and unknown severity
values are usage errors (exit 1). Violations honor ignore markers
(`string-hazards` is in `IGNORABLE_GATES`). Upstream's
`enabled`/`ignorable` config keys map to the port's conventions: the
gate is default-on as a subcommand, and ignorable is the hard-coded
registry entry. Dogfood: the gate runs clean on crap4js's own `src/`
(37 files, 0 findings).

### identical-branches

`crap4js identical-branches [--severity warning|error] [paths...]`
(port of the crap4dart identical_branches gate, upstream spec §11.26,
commit c6b2425add) flags the copy-paste-edit bug family — syntactically
identical pieces inside one construct where a second, slightly different
piece was intended. All comparisons use a canonical form:
whitespace-, comment- and parenthesis-independent (babel drops parens
and comments; the serializer walks the AST structurally, literals
compare by value), operands of commutative operators (`==`, `!=`,
`===`, `!==`, `&&`, `||`, `+`, `*`, `&`, `|`, `^`) sorted, same-operator
nests of the associative operators (`&&`, `||`, `+`, `*`, `&`, `|`, `^`)
flattened. Non-commutative operators (`<`, `>`, `<=`, `>=`, `-`, `/`,
`??`, ...) keep their operand order and shape: `a < b` and `b < a` stay
distinct, `a - (b - c)` never flattens. Six finding kinds, with the JS
host mapping:

1. **Duplicate conditions** — two links of one `if`/`else if` chain
   whose conditions compare equal; every later branch is unreachable.
2. **Duplicate branch bodies** — two bodies in one chain whose
   statements compare equal; a single-statement block compares equal to
   the naked statement, and the violation points at the unwrapped
   statement's line. An `else` equal to its `then` flags.
3. **Duplicate operands and absorbed operands** — one `&&`/`||` chain
   whose flattened operand list contains a repeated canonical operand
   (`a || a` collapses to `a`), or an operand that also appears
   standalone as another top-level operand's conjunct (for `||`) or
   disjunct (for `&&`) — the absorption law (`a || b && a` collapses to
   `a`). Only the outermost link of a same-operator chain is checked;
   parenthesized links are transparent (`a || (b || c)` is one chain).
4. **Identical ternary branches** — a conditional expression whose then
   and else expressions compare equal (`c ? x : x` — the condition is
   dead).
5. **Duplicate positional arguments** — one call whose positional
   argument list contains a repeated canonical argument, reported as
   `(same as argument N)` against the positional slots. JS adaptations,
   documented: JS has no named/keyword arguments, so upstream's
   named-argument exemption has no analog — an options object is one
   positional value like any other (two equal options objects in one
   call flag); a spread element occupies no fixed slot and is exempt.
   All-literal argument lists are exempt (uniform-value APIs like
   `rect(8, 8, 8, 4)` stay quiet) and a literal argument is never
   reported as the repeat.
6. **Duplicate handler bodies** — JS's `try` admits exactly one catch
   clause, so upstream's duplicate-catch-bodies check maps to the only
   remaining same-construct handler pair: catch body vs finally body.
   Identical failure and unconditional paths double-execute the same
   code — a copy-paste where the two were meant to differ. The violation
   points at the finally body (the later occurrence in source order,
   like every repeat report).

Only pieces of the *same* construct are compared; identical conditions
in separate `if` statements are legal (the state may change between
them), nested `if`s are their own chains. `switch` is excluded —
duplicate cases are a syntax error in JS strict mode, so upstream's
analyzer check has no counterpart. Severity: **warning by default** —
findings are printed but exit 0; `--severity error` exits 2 (same
discipline as string-hazards: reordering is equivalence-safe only for
side-effect-free operands, which pure syntax cannot prove). Unknown
`--flag=...` and unknown severity values are usage errors (exit 1).
Violations honor ignore markers (`identical-branches` is in
`IGNORABLE_GATES`). Upstream's `enabled`/`ignorable` config keys map to
the port's conventions: the gate is default-on as a subcommand, and
ignorable is the hard-coded registry entry. Upstream's
`GateRunner.defaultGates()` duplicate-registration cleanup is N/A here
— the subcommand dispatch table is a plain object literal (keys unique
by syntax), verified duplicate-free. Dogfood: the gate runs on
crap4js's own `src/` (1520 constructs); one finding, a deliberate
one-line range (`diffIntersects(..., site.line, site.line)`), carries a
reason-carrying `// ignore:identical-branches` marker — no real slips.

### collapsible-flow

`crap4js collapsible-flow [--severity warning|error] [paths...]`
(port of the crap4dart collapsible_flow gate, upstream spec §11.28,
commit 7bdfd64ae1) flags control-flow nesting that a
semantics-preserving mechanical rewrite can flatten, resolved from the
parsed AST only. Every finding is correct code — the gate trades
flatness, not bugs. Three checks, with the JS host mapping:

1. **Collapsible if** — an `if` without `else` whose then-branch
   contains only one statement that is itself an `if` without `else`
   (a block with the single inner `if` equals the naked statement, so
   both braced and unbraced shapes flag). The two conditions merge
   into a single `&&` condition; short-circuit evaluation preserves
   order, so the merge is always equivalent (including `await`ed or
   side-effecting conditions). JS has no pattern conditions
   (`if (x case P)` is Dart-only), so upstream's pattern-clause
   exclusion has no analog here.
2. **Redundant else** — an `if`/`else` whose then-branch always exits:
   ends with `return`, `break`, `continue`, or `throw` (JS's `throw`
   is a statement; Dart's `throw`/`rethrow` expressions map to
   `ThrowStatement`, and there is no rethrow), a block whose last
   statement exits, an `if`/`else` pair whose both branches exit, or a
   `try` whose body exits and whose finally is absent, empty, or
   exits. The `else` is redundant and its body dedents. An inner `if`
   without an `else` shall never count as exiting (control falls
   through when its condition is false — the upstream's own
   hard-learned trap); `switch` bodies shall not be analyzed (case
   fall-through), so a trailing `switch` never counts; catch handlers
   are not analyzed either — body and finalizer decide, like upstream.
3. **Chain after terminal then** — an `else if` following an
   always-exiting then-branch, flagged as a flattening hint (guard
   sequence or dispatch table); the rewrite is not mechanical, so the
   message shall not promise a specific fix. JS spells `else if` as
   the if's `alternate` being another `IfStatement` (no distinct node).

Labeled statements and loops are not analyzed either, so they never
count as exiting (conservative, like upstream). Severity: **warning by
default** — findings are printed but exit 0; `--severity error` exits
2 (every finding is correct code, the string-hazards discipline).
Unknown `--flag=...` and unknown severity values are usage errors
(exit 1). Violations honor ignore markers (`collapsible-flow` is in
`IGNORABLE_GATES`); upstream's `enabled`/`ignorable` config keys map to
the port's conventions: default-on subcommand, hard-coded registry
entry. Upstream's QualityGatesConfig subgroup refactor is N/A here —
crap4js has no config file (the port keeps its own flat conventions;
no subgroup anywhere to refactor). Dogfood: the first self-scan of
crap4js's own `src/` found three sites and all were fixed in-commit —
one collapsible if in `duplicates.js` (`collectFunctionLocals`,
conditions merged) and two redundant else bodies in the
`profile.js`/`reorder.js` flag parsers (the fallback dedents behind
the exiting throw, still guarded by the same branch — in a flat
else-if chain a blind dedent would move the fallback out of the
chain's else scope and change behavior, which the profile arg tests
caught during the port). The gate now runs clean on `src/`
(37 files, 509 if statements checked).

### non-null-assertion

`crap4js non-null-assertion [--severity warning|error] [paths...]`
(port of the crap4dart non_null_assertion gate, upstream spec §11.29,
commit e3ad58594c) flags every TS non-null assertion, resolved from
the parsed AST only. A bang crashes on null where the null-safe
alternatives carry the same intent with a readable check: `?.`/`??` —
the common check-then-bang ternary `E != null ? E!.m() : f` collapses
to `E?.m() ?? f` (single receiver evaluation, no bang). The gate
applies zero thresholds: any `!` is a finding, and every violation
shall carry the file and line of the `!` token (the bang is the
flagged node's last character, so the node's end line is the token's
line — an operand spanning several lines reports where the `!` sits,
not where the expression starts).

JS host mapping, per shape:

1. **Postfix `!` expression** — Dart's `x!`, `map['k']!`, and chains
   (`a!.b!`) map to the TypeScript `TSNonNullExpression` node, one
   node per bang, so a chain reports each `!` separately. Only
   `.ts`/`.tsx` files can carry the node: @babel/parser routes the
   typescript plugin by file extension (complexity.js parseSource) and
   the flow plugin has no such node — a `.js` file can never flag
   here.
2. **Null-assert pattern** — Dart's `case var x!:` has no TS analog;
   omitted, and so is upstream's pattern-side fix, the null-check
   pattern (`case var x?`).

Not flagged (distinct AST nodes — the exclusions hold by
construction): `!=`/`!==` (BinaryExpression), the logical-not prefix
`!x` (UnaryExpression), `++`/`--` (UpdateExpression), null-aware
access `?.` (OptionalMemberExpression/OptionalCallExpression), and
`??` (LogicalExpression). A bang inside a string or template literal
is literal text. Type casts are not bangs: `x as T` parses as
TSAsExpression, and the angle-bracket cast `<T>x` does not parse at
all under the port's jsx+typescript routing (ambiguous with JSX), so
neither reaches this gate.

Summary format: `M files scanned, no non-null assertions` on pass,
`N non-null assertion(s) (M files scanned)` on findings. Severity:
**warning by default** — findings are printed but exit 0;
`--severity error` exits 2. The warning default is upstream's posture:
on an existing codebase every removed `!` needs a per-site
nullability audit, and upstream adopts via the baseline ratchet
(`check --save-baseline`). crap4js ports NO baseline machinery
(upstream's `--save-baseline`/`--baseline` is in the not-ported list);
the ratchet stays a manual discipline: record the count this gate
reports, drive it to zero, then enforce with `--severity error`. Gate
ordering is N/A — the subcommand runs on demand, not in upstream's
fixed run order. Unknown `--flag=...` and unknown severity
values are usage errors (exit 1). Violations honor ignore markers
(`non-null-assertion` is in `IGNORABLE_GATES`); upstream's
`enabled`/`ignorable` config keys map to the port's conventions:
default-on subcommand, hard-coded registry entry. Upstream's
`gate_configs_quality.dart` reader and its config tests are N/A —
crap4js has no config file. Dogfood: the first self-scan of crap4js's
own source found zero bangs (40 files scanned; the repo has no
`.ts`/`.tsx` files, so the TS-only gate has no surface in this
codebase yet).

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
- 0.9.5 icon/PNG branding assets (commit b789739) — upstream branding
  only; no JS counterpart.
- 0.9.5 public `flush()` + flush-on-outermost-method-exit —
  Dart/flutter_test-specific (flutter_test fails on pending timers, so
  upstream cannot keep a timer alive and flushes when the outermost call
  returns instead). Node has no such restriction: the JS collector flushes
  at `process.on('exit')`, which covers the same short-run tail-loss risk.
  Ported instead: the 0.9.5 no-inflation guarantee — via per-pid output
  files (step 3 above) rather than upstream's delta-flush bookkeeping.

## reorder

Port of the crap4dart 0.22.0 reorder command (upstream spec §11.24,
commit 24a6f24f), a command with a deterministic contract, not a gate:
`reorder [--dry-run] [paths...]` rewrites class members into the
canonical order. The same input always produces the same output,
already-canonical files stay byte-identical (whatever their member
layout — single-line bodies and members sharing the header line are
preserved as written), and reordering an already-reordered file does
not change it (idempotent).

Canonical order — the JS adaptation of the upstream Dart table (JS has
no const-field kind, so static constants live with static fields):
static fields (`static x`, `static #x`, `static {}` blocks), instance
fields (`x`, `#x`, `accessor x`), constructor, static methods
(public), getters/setters (`get`/`set` at any staticness), public
methods, private methods (`#m` at any staticness). Kind wins over
staticness — a `static get g()` is an accessor, a `static #sp()` is a
private method. This is a documented JS-only deviation: upstream FINAL
buckets `isStatic` first (a Dart `static getter` lands under static
methods) and crap4py mirrors that staticness-first ladder; crap4js
keeps every accessor — however qualified — in one run. Members within
one category keep their original relative
order (a stable partition — the command never sorts alphabetically).

Doc comments and whole-line `//` comment blocks above a member move
with it — including a block separated from the member by a single
blank line; two or more blank lines detach the block. A detached block
stays in the file and travels with the member it precedes; comments
are never dropped (a comment that looks like code, `// fake() {}`, is
carried, not parsed). Members on the class header line keep the header
(`class A { // trailing` survives intact), class docs above the opener
are never stolen, and comments between the last member and the closing
brace stay put. Only top-level class declarations are reordered —
`export class` and `export default class` included; class expressions
and nested classes are untouched, as are TS enums and object literals
(member order is semantics there — the host analog of upstream's
never-touch enum bodies). Dart-only member kinds with no JS analog
(factory constructors, operators as a distinct kind) are omitted.

A file's line-ending style (LF or CRLF) is preserved, as is a missing
trailing newline. With `--dry-run` the command writes nothing, lists
the files that would change and exits 2 (0 when everything is already
canonical); by default it writes the files and exits 0. Default
selection is the `src/` walk; explicit paths may be files or
directories with any source extension. Files that fail to parse are
skipped with a note — never fatal. Transform invariants (idempotence,
token-multiset preservation, parseability) are verified on a fixture
corpus and on real repository files.

## skill

`crap4js skill` prints a JavaScript-adapted version of the crap4dart
profiling skill (when to profile, how the instrumentation works, how to read
the report) followed by one line on installing it as an agent skill. Exits 0.

## Non-Goals (v1)

- Branch / function / line-level coverage attribution (only statement
  coverage).
- Configurable source roots (only `src/`).
- Test-runner integration beyond `node --test` (no Jest / Mocha / Vitest
  auto-detection).
- HTML / JSON output formats (text report only).
