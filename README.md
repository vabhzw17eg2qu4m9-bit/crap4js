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
```

`--changed` is mutually exclusive with explicit paths. Unknown flags are a
usage error.

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
coverage file at its default path, before analyzing. On failure, the error is
printed to stderr and the CLI exits 1.

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
  test/
    crapScore.test.js
    complexity.test.js
    coverage.test.js
    analyzer.test.js
    report.test.js
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
