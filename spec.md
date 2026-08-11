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
```

`--changed` is mutually exclusive with explicit paths. Unknown flags are a
usage error (exit 1).

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
| `1`  | CLI usage error (bad flag, bad threshold, `--changed` + paths, unreadable). |
| `2`  | CRAP threshold exceeded. `CRAP threshold exceeded: <max> > <threshold>` is printed to stderr. |

## `--run-tests`

Runs `npx nyc --reporter=json --reporter=text node --test` (with
`npx c8 --reporter=json node --test` as a fallback) in the project root,
generating `coverage/coverage-final.json`, before analyzing. On failure, the
error is printed to stderr and the CLI exits 1.

## Non-Goals (v1)

- TypeScript / TSX / JSX support (acorn's `ecmaVersion: 'latest'` will not
  parse TS or JSX; parsing such a file errors out and is reported).
- Branch / function / line-level coverage attribution (only statement
  coverage).
- Configurable source roots (only `src/`).
- Test-runner integration beyond `node --test` (no Jest / Mocha / Vitest
  auto-detection).
- HTML / JSON output formats (text report only).
