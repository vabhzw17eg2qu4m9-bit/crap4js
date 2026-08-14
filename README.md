# crap4js

[![Quality](https://github.com/vabhzw17eg2qu4m9-bit/crap4js/actions/workflows/quality.yml/badge.svg)](https://github.com/vabhzw17eg2qu4m9-bit/crap4js/actions/workflows/quality.yml)
[![version](https://img.shields.io/github/v/release/vabhzw17eg2qu4m9-bit/crap4js?label=version)](https://github.com/vabhzw17eg2qu4m9-bit/crap4js/releases)
![CRAP](badges/crap.svg)
![coverage](badges/coverage.svg)

**CRAP (Change Risk Anti-Patterns) metric for JavaScript.**

`crap4js` computes the CRAP score for every function/method in a JavaScript
project by combining **cyclomatic complexity** (parsed from source via
[`acorn`](https://github.com/acornjs/acorn)) with **statement coverage**
(parsed from an Istanbul/nyc `coverage-final.json`). It is a port of
[`crap4java`](https://github.com/IstiN/crap4java) and a sibling of
`crap4dart`. The CLI, formula, complexity rules, report format, and exit
codes are identical across the three ports.

## The CRAP formula

```
CRAP = CC^2 * (1 - coverage)^3 + CC
```

- `CC` — cyclomatic complexity (integer ≥ 1)
- `coverage` — statement-coverage fraction in `[0.0, 1.0]`
- When coverage is unknown, CRAP is `null` (reported as `N/A`).

A function with high complexity **and** low coverage scores badly; the same
function with high coverage scores well. CRAP flags code that is risky to
change because it is both hard to understand and under-tested.

## Install

```bash
npm i -D crap4js
# or run ad-hoc:
npx crap4js
```

Runtime requirement: Node.js ≥ 20. The only runtime dependency is `acorn`.

## CLI usage

```
crap4js                  Analyze all .js/.mjs/.cjs files under src/.
crap4js --changed        Analyze git-changed source files under src/.
crap4js <path>...        Analyze explicit files / directories (expanded).
crap4js --help           Print this help and exit 0.
crap4js --coverage <p>   Override coverage file (default: coverage/coverage-final.json).
crap4js --threshold <n>  Override CRAP threshold (default: 8.0).
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
crap4js skill            Print the crap4js profiling skill for AI agents.
```

`--changed` is mutually exclusive with explicit paths. Unknown flags are a
usage error.

The gate-check subcommands (`file-naming`, `nesting`, `class-size`,
`weight-of-class`, `unused-code`, `unused-files`, `banned-imports`) are
ports of crap4dart 0.5.x gates. crap4js has no gate framework or config
file, so each gate is a subcommand with its default thresholds and the
shared exit-code contract: `0` pass/skip, `1` usage error, `2` violations.

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

If the coverage file is missing, a warning is printed to stderr and every
method is reported with `N/A` coverage and CRAP.

## `--run-tests`

Runs `npx nyc --reporter=json --reporter=text node --test` (falling back to
`npx c8 --reporter=json node --test`) in the project root, generating the
coverage file at its default path, before analyzing. On failure, the error
is printed to stderr and the CLI exits 1.

## `profile`

`crap4js profile [--name <pattern>] [--threshold <ms>] [--top <N>] [paths...]`
is a source-instrumentation profiler (ported from crap4dart 0.4.0): it makes
an instrumented temp copy of the project with every function body wrapped in
`performance.now()` + `try/finally`, runs `node --test` against it, and
reports exact per-function timing:

```
Profile Report (12 methods, total 87.51ms)
TOTAL(ms)      %  CALLS   MEAN(µs)   MAX(µs)  @60fps(ms) METHOD                         FILE:LINE
--------------------------------------------------------------------------------------------------
     18.23  20.8%     31      588.0      4200       35.28 walkForEntries                 src/complexity.js:164
```

Defaults: `--top 20`, threshold off. Full reports are written to
`profile-reports/profile-<timestamp>.txt` and `.json`. Exit 2 when any
function's total exceeds `--threshold` ms. `--name` is forwarded to
`node --test --test-name-pattern`.

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

## `skill`

`crap4js skill` prints a JavaScript-adapted profiling skill for AI agents
(when to profile, how the instrumentation works, how to read the report)
plus one line on installing it as an agent skill. Exits 0.

## Complexity rules

Base value `1`, then `+1` for each occurrence of:

| Construct                | acorn node type                              |
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

## Method extraction

An entry is produced for every:

- `FunctionDeclaration`
- `FunctionExpression` / `ArrowFunctionExpression` assigned to a variable or
  object-literal property (named after the variable / property)
- `MethodDefinition` inside a class body (named `ClassName.methodName`, or
  just `methodName` when the class is anonymous)
- Object-literal method shorthand / `{ key: function () {} }`

Truly anonymous function literals are reported as `<anonymous>`.

## Project layout

```
crap4js/
  package.json
  src/
    cli.js         argv parsing, exit codes
    crapScore.js   formula
    complexity.js  acorn-based complexity + method extraction
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
    gateCommon.js  shared gate-subcommand runner
    imports.js     import-specifier collection + resolution
    skill.js       skill command text
  test/
    crapScore.test.js
    complexity.test.js
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
    profile.test.js
    skill.test.js
    cli.test.js
    fixtures/
      sample.js
      high_crap.js
```

## Development

```bash
npm install     # acorn only
npm test        # node --test
```

### Pre-commit hook

A `crap4js` pre-commit hook lives in `githooks/pre-commit`. It runs the tool
on staged `*.js`/`*.mjs`/`*.cjs` files (threshold 8.0) and blocks the commit
when any function's CRAP exceeds the threshold. Enable it once after cloning:

```bash
git config core.hooksPath githooks
```

## License

MIT © 2026 IstiN and contributors. A port of `crap4java`.

