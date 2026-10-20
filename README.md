# crap4js

[![Quality](https://github.com/vabhzw17eg2qu4m9-bit/crap4js/actions/workflows/quality.yml/badge.svg)](https://github.com/vabhzw17eg2qu4m9-bit/crap4js/actions/workflows/quality.yml)
[![version](https://img.shields.io/github/v/release/vabhzw17eg2qu4m9-bit/crap4js?label=version)](https://github.com/vabhzw17eg2qu4m9-bit/crap4js/releases)
![CRAP](badges/crap.svg)
![coverage](badges/coverage.svg)

**CRAP (Change Risk Anti-Patterns) metric for JavaScript.**

`crap4js` computes the CRAP score for every function/method in a JavaScript
project by combining **cyclomatic complexity** (parsed from source via
[`@babel/parser`](https://github.com/babel/babel/tree/main/packages/babel-parser)) with **statement coverage**
(parsed from an Istanbul/nyc `coverage-final.json`). It is a port of
[`crap4java`](https://github.com/IstiN/crap4java) and a sibling of
`crap4dart`. The CLI, formula, complexity rules, report format, and exit
codes are identical across the three ports.

## The CRAP formula

```
CRAP = CC^2 * (1 - coverage)^3 + CC
```

- `CC` — the complexity value of the selected metric (`--metric`):
  cyclomatic complexity (integer ≥ 1) by default, or the cognitive score
- `coverage` — statement-coverage fraction in `[0.0, 1.0]`
- When coverage is unknown, CRAP is `null` (reported as `N/A`).

A function with high complexity **and** low coverage scores badly; the same
function with high coverage scores well. CRAP flags code that is risky to
change because it is both hard to understand and under-tested.

## Install

```bash
npm i -D github:vabhzw17eg2qu4m9-bit/crap4js
# or run ad-hoc:
npx crap4js
```

> **Warning:** the `crap4js` package on npm is an unrelated third-party
> project — install from GitHub as shown above.

Runtime requirement: Node.js ≥ 20. The only runtime dependency is
`@babel/parser`.

## CLI usage

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
crap4js profile [...]    Run instrumented tests and report per-function timing.
crap4js file-naming [...]  Flag mechanical file names (generic/numeric stems).
crap4js nesting [...]    Fail functions whose control-flow nesting exceeds 5.
crap4js class-size [...]  Fail god classes (>25 methods or WMC >80).
crap4js weight-of-class [...]  Fail data-heavy classes (field ratio >0.33).
crap4js unused-code [...]  Flag module-private declarations never referenced.
crap4js unused-files [...]  Flag source files never imported.
crap4js banned-imports [--from GLOB --forbid GLOB --message MSG]... [paths...]
                         Enforce architectural import boundaries.
crap4js magic-constants [paths...]
                         Flag hex colors outside constants and literals
                         repeated 3+ times in one file.
crap4js duplicates [--threshold N] [--min-tokens N] [--min-lines N]
                   [--report percentage|clones] [--ignore-locals]
                   [--ignore-literals] [--ignore-identifiers]
                   [--ignore-imports] [--skip-duplicate-files]
                   [--exclude GLOB]... [--source PATH]... [paths...]
                   Flag duplicated token windows within/across files;
                   clones mode reports one violation per clone group.
crap4js similarity [--format console|json] [--jaccard N]
                   [--containment N] [--min-shingles N]
                   [--include GLOB]... [--exclude GLOB]... [paths...]
                   Scan for near-duplicate files and print similarity
                   clusters; informational — always exits 0.
crap4js test-assertions [paths...]
                         Flag test()/it() bodies with zero assertion calls.
crap4js folder-structure Flag src/ directories with loose direct files.
crap4js mutation [--min-score N] [--max-survivors N]
                 [--timeout-seconds N] [--max-mutants N]
                 [--cache|--no-cache] [--test-args ARG]...
                 [--diff-base REF] [--scope-tests]
                 [--operators CAT]... [--exclude GLOB]... [paths...]
                 Mutate one operator/literal at a time and re-run the
                 test suite per mutant; covered sites only, survivors
                 flagged. Killed mutants of unchanged methods are
                 replayed from .crap-mutation-cache.json (--no-cache
                 disables); --test-args scopes the per-mutant suite;
                 --diff-base executes only the mutants of methods
                 changed vs REF; --scope-tests narrows each mutant to
                 its file's derived test files (scoped kills cache as
                 kills; survivors are re-confirmed against the full
                 suite).
crap4js skill            Print the crap4js profiling skill for AI agents.
```

`--changed` is mutually exclusive with explicit paths. Unknown flags are a
usage error.

The gate-check subcommands (`file-naming`, `nesting`, `class-size`,
`weight-of-class`, `unused-code`, `unused-files`, `banned-imports`,
`magic-constants`, `duplicates`, `similarity`, `test-assertions`,
`folder-structure`, `mutation`) are ports of
crap4dart gates. crap4js has no gate framework or config
file, so each gate is a subcommand with its default thresholds and the
shared exit-code contract: `0` pass/skip, `1` usage error, `2` violations
(`similarity` is informational and always exits 0 — see its section).

### Example

```bash
npx nyc --reporter=json --reporter=text node --test
npx crap4js
```

Output:

```
CRAP Report
===========
Method                         File                                  CC    Cov%     CRAP
----------------------------------------------------------------------------------------
deepNested                     src/high_crap.js                       5    0.0%     30.0
addPositive                    src/sample.js                          2  100.0%      2.0
identity                       src/sample.js                          1     N/A      N/A

Max CRAP: 30.0 (threshold 8.0) — FAILED
```

## Exit codes

| Code | Meaning                                                                       |
|------|-------------------------------------------------------------------------------|
| `0`  | Success (empty selection, or max numeric CRAP ≤ threshold).                   |
| `1`  | CLI usage error (bad flag, bad threshold value, `--changed` + paths, etc.).   |
| `2`  | CRAP threshold exceeded (max numeric CRAP > threshold).                       |

## Coverage format

`crap4js` reads the standard Istanbul / nyc JSON written to
`coverage/coverage-final.json`:

```json
{
  "/abs/path/to/file.js": {
    "statementMap": {
      "0": { "start": { "line": 1, "column": 0 }, "end": { "line": 1, "column": 12 } }
    },
    "s": { "0": 5 }
  }
}
```

Per-method attribution: for each statement whose `[start.line, end.line]`
intersects the method's `[startLine, endLine]`, count it as covered when
`s[id] > 0`. The fraction is `covered / total`. If no statements intersect,
the method's coverage and CRAP are `N/A`. Absolute file-path keys are
relativised against the project root; entries outside the project root are
ignored.

If the coverage file is missing, a warning is printed to stderr (including
the command to generate it — `npx c8 --reporter=json node --test`) and every
method is reported with `N/A` coverage and CRAP.

## `--run-tests`

Runs `npx nyc --reporter=json --reporter=text node --test` (falling back to
`npx c8 --reporter=json node --test`) in the project root, generating the
coverage file at its default path, before analyzing. On failure, the error
is printed to stderr and the CLI exits 1.

## `profile`

`crap4js profile [--name <pattern>] [--threshold <ms>] [--top <N>] [paths...]`
is a source-instrumentation profiler (ported from crap4dart 0.4.0): it makes
an instrumented temp copy of the project where every function body reports
entry/exit to a collector (which keeps a call stack of open calls), runs
`node --test` against it, and reports exact per-function timing:

```
Profile Report (2 methods, total 11.44ms)
     TOTAL       SELF      %  CALLS   MEAN(µs)   MAX(µs)  @60fps(ms) METHOD                         FILE:LINE
-------------------------------------------------------------------------------------------------------------
   11.04ms    10.68ms  96.6%      1    11044.0     11044      662.64 slow                           src/add.js:4
    0.39ms     0.39ms   3.4%   1001       ~0.4       316        0.02 add                            src/add.js:1
```

- **TOTAL** — inclusive time across all calls; **SELF** — TOTAL minus
  nested profiled calls (flamegraph self-time — ranks hot code by actual
  CPU burn). TOTAL, SELF, and the summary total render with adaptive units
  (`82.50ms`, `13.89s`, `22.50m`, `13.89h`) so extreme call counts stay
  compact.

Defaults: `--top 20`, threshold off. Full reports are written to
`profile-reports/profile-<timestamp>.txt` and `.json`. Exit 2 when any
function's total exceeds `--threshold` ms. `--name` is forwarded to
`node --test --test-name-pattern`. Positional paths select which tests run
(`node --test <paths...>`) and are remapped into the instrumented temp copy
— pointing them at the original project would run non-instrumented tests
and record no timings. The full `src/` set is always instrumented and
attributed. MEAN values marked `~` are sub-30µs — instrumentation overhead
dominates there; read the CALLS/TOTAL deltas instead.

## `file-naming`

`crap4js file-naming [paths...]` flags mechanical file names — generic
stems (`utils.js`, `helpers.ts`) and numeric suffixes (`batch1.js`,
`report2.js`) — that indicate code split without a domain boundary. Stems
where digits carry meaning (`base64`, `sha256`, `utf8`, ...) are allowed;
test files/directories are excluded. One line per violation plus a summary;
exit 2 iff violations exist.

## `nesting`

`crap4js nesting [paths...]` (port of crap4dart's nesting gate) fails
functions whose maximum control-flow nesting exceeds 5 levels. The
function body counts as level 1; every nested control-flow construct
(`if`, `for`, `while`, `do-while`, `switch`, `try`) adds one — including
constructs inside arrow/function-literal bodies. Output is one
`file:line: name nesting=N > max 5` line per violation plus a summary;
exit 2 iff violations exist.

## `class-size`

`crap4js class-size [paths...]` (port of crap4dart's class_size gate)
fails classes that are too big as a whole even when every method passes
the complexity check individually: more than 25 concrete methods, or a
weighted-methods-per-class sum (total cyclomatic complexity over all
methods, counted with the same rules as `analyze`) above 80. Constructors
and top-level functions are excluded; methods of nested classes belong to
the nested class. Exit 2 iff violations exist.

## `weight-of-class`

`crap4js weight-of-class [paths...]` (port of crap4dart's
weight_of_class gate) fails classes that reveal more data than behavior:
the ratio of public instance fields to public instance members exceeds
0.33. Static and private (`#`) members are excluded; classes without
public instance fields are never flagged, so plain data/model classes are
not reported. Exit 2 iff violations exist.

## `unused-code`

`crap4js unused-code` (port of crap4dart's unused_code gate, adapted to
ESM visibility) flags module-scope declarations that are never referenced
anywhere else in their module: non-exported function declarations, class
declarations, and `const`/`let`/`var` declarators whose identifier appears
nowhere else. References are counted lexically, which keeps the check
conservative. Test files are excluded entirely — both their declarations
and their references — so a helper used only by tests is flagged. This is
a whole-project check: when explicit paths are given it prints
`not meaningful for a partial selection — skipped` and exits 0, because a
partial file set yields false positives.

## `unused-files`

`crap4js unused-files` (port of crap4dart's unused_files gate) flags
non-test source files that are never imported by any analyzed non-test
file. Relative import specifiers are resolved against the importing
file's directory (trying the exact path, source extensions, and
`/index.<ext>`); bare specifiers name external packages and never count.
Static imports, re-exports, dynamic `import()`, and `require()` are all
collected. Like `unused-code`, this is a whole-project check: with
explicit paths it prints the skip message and exits 0.

## `banned-imports`

`crap4js banned-imports [--from GLOB --forbid GLOB --message MSG]...
[paths...]` (port of crap4dart's banned_imports gate, which reads the
same rules from its YAML config) enforces architectural boundaries: for
every file matching a rule's `from` glob, each import whose specifier —
or, for relative imports, its resolved project-relative path — matches
the `forbid` glob is a violation; the optional message is appended to the
violation line. Rules are `--from`/`--forbid` pairs zipped in CLI order
(`--message` optional per pair, `--flag=value` also accepted). With no
rules the command prints `no rules configured` and exits 0; unbalanced or
unknown flags are a usage error (exit 1). Globs: `*` matches within one
path segment, `**` across segments, `?` one character.

## `magic-constants`

`crap4js magic-constants [paths...]` (port of crap4dart's
magic_constants gate, 0.6.x–0.9.x) flags magic literals. Two checks per
file: (a) hex color integer literals (`0xRRGGBB` / `0xAARRGGBB`, 6–8 hex
digits) outside named constant declarations — every line spanned by a
`const` initializer (the full nested subtree: call arguments, object
elements, nested calls) is exempt; (b) numeric (by raw lexeme) and string
literals (value length ≥ 4) whose value repeats 3+ times in one file —
every occurrence is reported as `literal <value> repeats N times —
extract a named constant`. Lines inside a `const` initializer are exempt
from the duplicates check too. String literals in identifier positions —
object/dict keys, computed member indexes (`obj['name']`), switch case
labels — are never counted: they name protocol values (JSON fields,
channels, enums), not constants. Template literals with interpolations
are skipped; plain no-interpolation templates count as strings. Defaults
are baked in (min_duplicates=3, min_length=4, hex rule on) — crap4js has
no config. Any `--flag` argument is a usage error (exit 1). Exit 2 iff
violations exist.

## `duplicates`

`crap4js duplicates [--threshold N] [--min-tokens N] [--min-lines N]
[--report percentage|clones] [--ignore-locals] [--ignore-literals]
[--ignore-identifiers] [--ignore-imports] [--skip-duplicate-files]
[--exclude GLOB]... [--source PATH]... [paths...]` (port of crap4dart's
duplication gate, 0.9.x incl. commit d6c3ab6, including its per-gate
`sources` union) detects copy-paste duplicates. Every scanned file is
tokenized (comments skipped) and windows of `--min-tokens` tokens
(default 50) spanning at least `--min-lines` source lines (default 5)
are indexed; every window appearing twice or more — within or across
files — grows a clone group whose occurrences extend to the maximal
extent they share. Accepted groups are non-overlapping, longest first
(PMD CPD Match semantics); the windows are compared by exact token
equality (the port indexes joined token strings, so fingerprint
collisions cannot arise).

`--report` chooses the verdict style: `percentage` (the default) fails
each file whose distinct duplicated lines exceed `--threshold` percent
(default 1), reporting the first duplicated line; `clones` (PMD CPD
style) fails once per accepted clone group with all its occurrence
locations (`file:line-line`) in the message, at most three inline. In
percentage mode only accepted groups mark lines — an overlapping shorter
clone no longer inflates a file's percent.

Opt-in normalizations extend detection beyond exact copy-paste:

- `--ignore-locals`: identifiers declared inside a function — parameters
  (except TS parameter properties, which reference API state), local
  variables, loop and catch variables, type parameters, local functions,
  and destructuring bindings — are renamed to `$L1`, `$L2`, ... in
  first-use order before hashing. Renamed clones hash identically, while
  locals swapped against each other keep different placeholders and never
  match. The API surface — called method names, type names, field
  references — keeps its lexeme. Template literals need no masking of
  their own: babel's stream keeps their static text as opaque constant
  chunks and the embedded identifiers are renamed like any other local.
- `--ignore-literals`: string and numeric literal tokens are replaced
  with `$STR`/`$NUM` placeholders before hashing.
- `--ignore-identifiers`: every identifier-shaped token collapses to one
  `$ID` placeholder (CPD `--ignore-identifiers`, structure-only
  matching). babel labels contextual keywords (`async`, `of`, `from`,
  `as`, `get`, ...) as plain `name` tokens, so they are masked too — the
  JS analog of upstream's built-in/pseudo keyword slots — along with
  `#private` names; real keywords keep their lexeme.
- `--ignore-imports`: import/export directives and CommonJS `require()`
  calls are excluded from tokenization (upstream masks
  import/export/part; `require` is the CJS import). `export` wrapping
  real code keeps the code — only the `export`/`export default` keywords
  drop out; a brace re-export (`export { a, b } [from '...']`) is
  directive boilerplate throughout and drops whole.
- `--skip-duplicate-files`: a file whose token stream equals an earlier
  file's (by masked value, so copies differing only in comments count
  too) is analyzed once (CPD `--skip-duplicate-files`) — a copied file
  is reported once, not as N x N pairs.

With the flags off the gate reports exact copy-paste only. Detection is
a union of two passes (upstream 94299e0): the raw-lexeme pass runs
alongside the masked one whenever local renaming is on, so enabling
`--ignore-locals` can only add findings — exact copies are never lost
when enclosing scopes shift the placeholder numbering. Candidates from
both passes compete in one greedy selection: a longer renamed clone wins
over the shorter exact copy it contains.

The scan set is the standard gate selection (explicit paths or the
`src/` walk — test files and test directories always excluded) unioned
with every `--source` path: files with a source extension are taken
directly, directories are scanned recursively, missing paths are skipped
silently. That is what makes cross-module duplication visible without
widening the CRAP analysis scope. `--exclude` globs (same
`*`/`**`/`?` semantics as banned-imports) drop matching project-relative
paths from the union. Files with fewer than `--min-tokens` tokens are
skipped from the scan. Exit 2 iff violations exist.

## `test-assertions`

`crap4js test-assertions [paths...]` (port of crap4dart's test_assertions
gate, 0.9.x, mapped to node:test) flags `test()`/`it()` bodies that contain
zero assertion calls — a test without assertions compiles, runs green, and
verifies nothing. Counted as assertions:

- any call through a binding imported from `node:assert`/`assert`
  (including `/strict` variants): default calls (`assert(x)`), member
  calls (`assert.strictEqual(...)`), and destructured/renamed named
  imports (`ok(x)`, `equal(...)`) — every export of the assert module is
  an assertion;
- `t.assert.*` calls on the node:test context parameter.

`test.skip`/`it.only` forms are checked too; body-less forms (`test.todo`)
are skipped; tests inside `describe()` callbacks are checked individually.
Default file set: `test/` recursively plus colocated `*.test.js`/
`*.spec.js` under `src/`; explicit paths are kept verbatim. min_assertions
(default 1) is baked in. Exit 2 iff violations exist.

## `folder-structure`

`crap4js folder-structure` (port of crap4dart's folder_structure gate,
0.9.x) flags directories containing more than `max_loose_files` (default
0) source files DIRECTLY — a flat-file sprawl that should be organized
into feature packages. Only direct children of `src/` (the port's source
root) count; files in subdirectories are the organized form. Violation:
`N loose files directly in src — group them into feature packages
(max 0)`. Takes no arguments (any argument is a usage error); the
directory and threshold are baked in. Exit 2 iff violations exist.

## `mutation`

`crap4js mutation [...]` (port of crap4dart's mutation gate, commit
c865ec3, adapted from the unclebob/mutator research conclusions) runs
mutation testing over the selected sources: a declarative,
category-tagged operator table is matched on the parsed babel AST — every
replacement span comes from node/token offsets, never regex:

- `arithmetic`: `+`↔`-`, `*`↔`/`, `/`→`%` (upstream's Dart `~/` has no JS
  form; modulo is the analog)
- `boundary`: `>`↔`>=`, `<`↔`<=`, `>`↔`<`, `>=`↔`<=`
- `equality`: `==`↔`!=`, `===`↔`!==` (the strict forms are JS-only)
- `logical`: `&&`↔`||`
- `boolean`: `true`↔`false`
- `constant`: integer `0`↔`1`, `-1`→`0` (the `1` operand yields its own
  site too, like upstream)
- `unary`: delete a `!` prefix (prefix expressions only — the postfix TS
  non-null `!` would corrupt its operand)

Only COVERED sites are scored: a site is covered when its containing
method was executed (Istanbul coverage, `coverage/coverage-final.json`)
and the site's line is not recorded as unexecuted; sites in unexecuted
code are `uncovered` — excluded from the score denominator and never
executed. Every covered site is then mutated one at a time and the
project's test suite re-runs against it (`node --test` in the project
root, the analog of upstream's `dart test`). A non-zero exit kills the
mutant — a module-load failure plays the Dart compile-error role, since
the suite refuses to run. A timeout counts as survived: the suite did not
kill the mutant deterministically. The file is restored after every
mutant, also after timeouts and errors; an end-of-run tree integrity
check (port of crap4dart 8b2e8e8) snapshots every file before the loop
and re-verifies the whole tree in an outer finally — files that drifted
(an out-of-band write defeating the per-site restore) are re-restored
and surfaced as `INTEGRITY` violations in the summary plus a stderr
warning.

The mutation score is `killed / (killed + survived)`. The gate fails when
the score is below `--min-score` (default 0.8) or more than
`--max-survivors` (default 0) mutants survive, reporting one violation
per survivor: `src/lib.js:2: survived constant mutant \`0\` -> \`1\` in
sign`. Summary: `mutation score 83.3% (5 killed, 1 survived, 0
uncovered, 0 cached)`, with `; survivors by category: constant=1`
appended on failure. Skips (exit 0) without coverage data or a `test/`
directory. `--timeout-seconds` (default 60) bounds each mutant run,
`--max-mutants` (default 500) caps the executed sites deterministically
(file order, then offset), `--operators` selects a category subset
(default: all), `--exclude` globs skip files project-relatively.

**Digest-incremental cache** (port of crap4dart 16d9c4c,
"killed-stays-killed"): killed mutants of methods whose exact source span
is unchanged since the last run are replayed from
`.crap-mutation-cache.json` at the project root (counted killed, reported
as `cached`) instead of re-executing the suite; survivors and timeouts
are always re-executed because the suite may have improved, and coverage
gating is re-derived from fresh coverage every run. Sites are stored
method-relative (offsets relative to the containing method's start, keyed
by an FNV-1a digest of the method's exact source text), so an edit in an
earlier method of the same file invalidates only that method. The
envelope carries a meta fingerprint — tool version, enabled operators,
`--test-args` — and any mismatch (or a corrupt/outdated file) wipes the
cache into a full re-execution. `--cache`/`--no-cache` (default: cache
on) opt out entirely. `--test-args ARG` (repeatable, default `--test`)
scopes the per-mutant invocation (`node <args...>`): scoping the suite is
your responsibility — a mutant counts as killed only if the scoped suite
would kill it.

**Diff-scoped execution** (port of crap4dart 8228585): under
`--diff-base REF` the gate runs `git diff -U0 REF` over the scanned paths
and intersects the candidate sites with the changed lines BEFORE
executing — method-level: a site runs only when its containing method
intersects the diff (sites outside every method fall back to their own
line). Everything outside the diff is not a mutant of this change and is
neither executed nor counted, so a per-PR run pays only for the mutants
of the changed methods. A git failure (not a repository, unknown ref) is
a usage error (exit 1).

**scope_tests** (port of crap4dart 8228585, `--scope-tests`, default
off): each mutant's invocation is narrowed to the derived test file(s) of
the mutated file — `src/foo/bar.js` → `test/src/foo/bar.test.js` and
`test/foo/bar.test.js`, whichever exist — falling back to the full
invocation when no candidate exists. A scoped kill is monotone (the
scoped invocation is a subset of the full suite) and is cached as a
regular kill; a scoped survivor — timeout included — is re-confirmed
once against the full invocation, and only the confirmed outcome is
reported and cached. The summary appends
`; test-scoped N (M re-confirmed killed)` when scoping ran.

Mutation testing runs the test suite once per mutant — expensive — so
like every gate here it only runs when invoked as the `mutation`
subcommand (upstream: disabled by default). Enable it on fast suites.

## `similarity`

`crap4js similarity [...]` (port of crap4dart's 0.15.0 similarity
engine + command, upstream spec §11.23, commit 2b21966) scans a text
corpus for near-duplicate FILES — copied docs that drifted apart, twin
templates, stale snapshot copies, generated files duplicating their
sources. Unlike `duplicates` (token-level clone blocks inside source),
a match means "this file is (mostly) a copy of that file" — reuse,
generate or delete, not extract-method.

```
crap4js similarity [--format console|json] [--jaccard N]
                   [--containment N] [--min-shingles N]
                   [--include GLOB]... [--exclude GLOB]... [paths...]
```

Detection is parser-free and language-agnostic. Each file is normalized
by its profile — markdown (`.md`/`.markdown`/`.mdx`) drops fenced code
blocks and keeps the prose words; code (25 source extensions) strips
comments and import-family lines, lowercases identifiers and maps
string/number literals to `S`/`N` placeholders; anything else compares
as-is. The normalized token stream is cut into 8-token shingles; file
pairs are compared by Jaccard (intersection over union) and containment
(how much of the smaller file the larger one reproduces — catches a
small file copied into a big one). A pair is reported when EITHER metric
meets its threshold; transitively connected pairs merge into clusters
(union-find), largest first.

Defaults mirror the upstream gate template (`gates.similarity` in
crap4dart.yaml — crap4js has no config file, so they are kebab-case CLI
flags): include `**/*.md`, exclude `.git/** node_modules/** build/**
coverage/**`, `--min-shingles 50` (files below the floor are skipped),
`--jaccard 0.8`, `--containment 0.95`. Positional paths override the
scan dirs: one existing directory becomes the scan root, several paths
are subdirectories of the project root.

The command is upstream's ad-hoc exploration tool for tuning the
thresholds — upstream pairs it with a config gate (`enabled: false` by
default); crap4js has no gate framework, so nothing runs unless invoked
and the command is informational: it ALWAYS exits 0, clean or dirty.
Flag validation errors are usage errors (exit 1). `--format json` prints
`{scanned, skipped, thresholds, pairs, clusters}` (thresholds echoed as
`jaccard`/`containment`/`min_shingles`, pair metrics rounded to 4
decimals) with stdout kept JSON-only.

The repo's own md corpus measures clean at the dogfood thresholds
(jaccard 0.6 / containment 0.9) — and still at 0.5/0.85.

## `skill`

`crap4js skill` prints a JavaScript-adapted profiling skill for AI agents
(when to profile, how the instrumentation works, how to read the report)
plus one line on installing it as an agent skill. Exits 0.

## Complexity rules

Base value `1`, then `+1` for each occurrence of:

| Construct                | Babel node type                              |
|--------------------------|----------------------------------------------|
| `if`                     | `IfStatement`                                |
| `for`                    | `ForStatement`                               |
| `for-in` / `for-of`      | `ForInStatement` / `ForOfStatement`          |
| `while`                  | `WhileStatement`                             |
| `do-while`               | `DoWhileStatement`                           |
| `catch`                  | `CatchClause`                                |
| `switch` case / `default`| `SwitchCase` (including default)             |
| ternary                  | `ConditionalExpression`                      |
| `&&` / `\|\|`            | `LogicalExpression`                          |

- Arrow / anonymous function-literal bodies count TOWARDS the enclosing
  function (we descend into them when computing the parent's complexity).
- Nested NAMED `FunctionDeclaration`s are reported as their own entries and
  are NOT counted toward the enclosing function.
- Class `constructor` methods are excluded.

## Cognitive complexity

`--metric cognitive` swaps the cyclomatic path count for SonarSource
Cognitive Complexity (v1.2) — the CRAP formula, threshold, and exit codes
are unchanged. The report column is relabeled `Cogn`.

- The score starts at `0`; it tracks how hard a method is to *read*, not how
  many paths it has.
- `+1` per flow break: `if`, `else if`, `else`, every loop kind, `catch`,
  each `switch` case (including `default`), the ternary `?:`, and each
  *sequence* of identical `&&`/`||` operators (`a && b && c` is one
  sequence → +1; `a && b || c` is two → +2).
- Structural constructs add a nesting increment of `+1` per enclosing
  structural level on top of their basic increment (an `if` inside a loop
  body scores 2); logical operators never deepen.
- `else if` chains are flat — each chained `if` increments at its
  originating `if`'s depth — while an `if` inside an `else` *block* keeps
  paying the nesting penalty.
- Lambda (function/arrow expression) bodies deepen one level but the lambda
  itself never increments; nested NAMED `FunctionDeclaration`s are skipped,
  as with cyclomatic.

Upstream mapping: crap4dart exposes the same choice as its
`gates.complexity.metric` config option; crap4js has no config file, so the
option is a CLI flag (the port's standard surface for gate options).

## Method extraction

An entry is produced for every:

- `FunctionDeclaration`
- `FunctionExpression` / `ArrowFunctionExpression` assigned to a variable or
  object-literal property (named after the variable / property)
- `ClassMethod` / `ClassPrivateMethod` inside a class body (named
  `ClassName.methodName`, or just `methodName` when the class is anonymous)
- Object-literal method shorthand / `{ key: function () {} }`

Truly anonymous function literals are reported as `<anonymous>`, as are
entries whose only name would come from a string or numeric object key.
A computed key is used only when it is a bare identifier, and then it is
read as written: `{ [name]() {} }` is reported as `name` rather than the
value `name` holds, while `{ [obj.name]() {} }` is `<anonymous>`.

## Project layout

```
crap4js/
  package.json
  src/
    cli.js         argv parsing, exit codes
    crapScore.js   formula
    complexity.js  Babel-based complexity + method extraction
    coverage.js    Istanbul JSON parsing + per-method attribution
    analyzer.js    combine parse + coverage → MethodMetric[]
    report.js      tabular formatter
    files.js       source finder + git-changed + path expansion
    runtests.js    --run-tests helper
    instrument.js  profile command source instrumentation
    profile.js     profile command runner + report
    fileNaming.js  file-naming command
    nesting.js     nesting command
    classSize.js   class-size command
    weightOfClass.js  weight-of-class command
    unusedCode.js  unused-code command
    unusedFiles.js unused-files command
    bannedImports.js  banned-imports command
    magicConstants.js  magic-constants command
    testAssertions.js  test-assertions command
    folderStructure.js  folder-structure command
    mutation.js   mutation command (operator table, engine, coverage gating)
    mutationCache.js  digest-incremental mutation cache (killed-stays-killed)
    gateCommon.js  shared gate-subcommand runner
    imports.js     import-specifier collection + resolution
    skill.js       skill command text
  test/
    crapScore.test.js
    complexity.test.js
    cognitive.test.js
    coverage.test.js
    analyzer.test.js
    report.test.js
    files.test.js
    fileNaming.test.js
    nesting.test.js
    classSize.test.js
    weightOfClass.test.js
    unusedCode.test.js
    unusedFiles.test.js
    bannedImports.test.js
    magicConstants.test.js
    testAssertions.test.js
    folderStructure.test.js
    profile.test.js
    skill.test.js
    cli.test.js
    fixtures/
      sample.js
      high_crap.js
```

## Development

```bash
npm install     # @babel/parser, plus c8 for coverage
npm test        # node --test
```

### Pre-commit hook

A `crap4js` pre-commit hook lives in `githooks/pre-commit`. It runs the tool
on staged `*.js`/`*.jsx`/`*.ts`/`*.tsx`/`*.mjs`/`*.cjs` files (threshold 8.0)
and blocks the commit
when any function's CRAP exceeds the threshold. Enable it once after cloning:

```bash
git config core.hooksPath githooks
```

## License

MIT © 2026 IstiN and contributors. A port of `crap4java`.

