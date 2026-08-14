// Source instrumentation for the `profile` command.
//
// Wraps every function body — located with the SAME extraction rules the
// analyzer uses (complexity.js) — in a `performance.now()` timer plus a
// record-on-exit `try/finally`. The record call targets
// `globalThis.__crap_record`, installed by the preload module written into
// the instrumented copy, so no import rewriting is needed (works for ESM
// and CJS alike).

import { extractMethodsWithNodes } from './complexity.js';

const TIMER_VAR = '__crap_t0';

// Profiling key: "<relFile>|<method>" — matches the analyzer inventory.
export function methodKey(relFile, name) {
  return `${relFile}|${name}`;
}

/**
 * Instrument source code, wrapping each function body in timer + try/finally.
 *
 * @param {string} source  JavaScript/JSX/Flow/TypeScript source code.
 * @param {{ ext?: string, relFile?: string }} [opts]
 *   `ext` routes the parser plugins; `relFile` is the project-relative path
 *   baked into the profiling keys.
 * @returns {string} instrumented source (unchanged when nothing to wrap).
 */
export function instrumentSource(source, { ext, relFile = '' } = {}) {
  const insertions = [];
  for (const entry of extractMethodsWithNodes(source, { ext })) {
    collectInsertion(entry, relFile, insertions);
  }
  return applyInsertions(source, insertions);
}

// Records the two insertion points for one function: the timer + `try {`
// right after the body's opening brace, and `} finally { record }` before
// its closing brace. Block-less bodies (arrow expressions) and empty
// blocks are skipped.
function collectInsertion({ name, node }, relFile, insertions) {
  const body = node.body;
  if (!body || body.type !== 'BlockStatement' || body.body.length === 0) return;
  const record = `__crap_record(${JSON.stringify(methodKey(relFile, name))}, ${TIMER_VAR})`;
  // Babel offsets are half-open [start, end): the braces live at body.start
  // and body.end - 1, so insert just after the opening and just before the
  // closing one.
  insertions.push({
    offset: body.start + 1,
    text: `\n  const ${TIMER_VAR} = performance.now();\n  try {`,
  });
  insertions.push({ offset: body.end - 1, text: `} finally { ${record}; }\n` });
}

// Apply insertions from the largest offset down so earlier offsets never
// shift. Nested functions inside an outer body land at strictly larger
// offsets than the outer opening insertion and strictly smaller ones than
// the outer closing insertion, so no pair ever overlaps.
function applyInsertions(source, insertions) {
  insertions.sort((a, b) => b.offset - a.offset);
  let result = source;
  for (const ins of insertions) {
    result = result.slice(0, ins.offset) + ins.text + result.slice(ins.offset);
  }
  return result;
}
