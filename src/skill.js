// `skill` subcommand: prints a crap4js-adapted version of the crap4dart
// profiling skill for AI agents, ending with one install line.

const SKILL = `# crap4js Profiling Skill

## When to Use

Use this skill when the user wants to:

- Find performance bottlenecks in JavaScript/TypeScript code
- Measure per-function execution time (microsecond precision)
- Profile \`node --test\` suites to see which functions are expensive
- Identify frequently-called functions that accumulate cost

## What is crap4js profile?

\`crap4js profile\` is a source-instrumentation profiler. It wraps every
function body in the analyzed sources with \`performance.now()\` +
\`try/finally\`, runs \`node --test\` against the instrumented copy, and
reports exact per-function timing.

Unlike sampling profilers (statistical), this gives **exact** timing for
every single call — no missed fast functions.

## Basic Usage

\`\`\`bash
crap4js profile                       # all tests, top 20 shown
crap4js profile --name "collab"       # only tests matching a name pattern
crap4js profile --top 10              # limit console output
crap4js profile --threshold 10.0      # exit 2 when a function exceeds 10ms total
crap4js profile test/report.test.js   # specific path
\`\`\`

## Reading the Report

Console columns:

| Column       | Meaning                                  |
|--------------|------------------------------------------|
| \`TOTAL(ms)\`  | Total time across all calls              |
| \`%\`          | Share of total profiling time            |
| \`CALLS\`      | Number of invocations                    |
| \`MEAN(µs)\`   | Average time per call                    |
| \`MAX(µs)\`    | Worst single call                        |
| \`@60fps(ms)\` | Cost if called every frame (mean × 60)   |

Full (untruncated) reports are saved to \`profile-reports/\` as
\`profile-<timestamp>.txt\` and \`.json\`.

## Analyzing Results

1. **High TOTAL + high CALLS** — function called too often. Cache/debounce it.
2. **High MEAN** — single call is expensive. Algorithm/data structure issue.
3. **High MAX >> MEAN** — occasional spikes. GC, I/O, or contention.

## How It Works

1. Creates \`.crap_profile_temp/\` with an instrumented copy of the analyzed
   sources (inside the project root, so \`node_modules\` resolves normally)
2. Every function body wrapped in \`performance.now()\` + \`try/finally\`
3. A collector is preloaded via \`NODE_OPTIONS --import\`; it merges timing
   data across test processes with atomic file writes
4. \`node --test\` runs against the copy; timings are attributed to the
   analyzer's method inventory (unmatched entries ignored)
5. Temp directory cleaned up automatically; reports saved to
   \`profile-reports/\`

## Limitations

- Arrow functions with expression bodies (\`() => x\`) are not instrumented
- Test files are not instrumented (only analyzed sources)
- Profiling adds ~2-3x overhead (timing + flush I/O)
- No --tags/--exclude-tags (\`node --test\` has no tag concept) — use
  \`--name\` patterns instead
`;

/**
 * The `skill` command body: prints the skill text and one install line.
 * Always exits 0.
 */
export function runSkill(ctx) {
  ctx.out.write(SKILL);
  ctx.out.write(
    'Install as an agent skill: ' +
      'mkdir -p .agents/skills/crap4js-profiling && ' +
      'crap4js skill > .agents/skills/crap4js-profiling/SKILL.md\n',
  );
  return 0;
}
