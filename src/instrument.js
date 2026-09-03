// Source instrumentation for the `profile` command.
//
// Wraps every function body — located with the SAME extraction rules the
// analyzer uses (complexity.js) — in an enter-on-entry `try/finally` whose
// `finally` reports the exit. The calls target `globalThis.__crap_enter` /
// `globalThis.__crap_exit`, installed by the preload module written into
// the instrumented copy, so no import rewriting is needed (works for ESM
// and CJS alike). The collector owns the timing (a stack frame per open
// call), which also lets it subtract nested call time to compute self time.

import { extractMethodsWithNodes } from './complexity.js';

// Profiling key: "<relFile>|<method>" — matches the analyzer inventory.
export function methodKey(relFile, name) {
  return `${relFile}|${name}`;
}

/**
 * Instrument source code, wrapping each function body in enter + try/finally.
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

// Records the two insertion points for one function: `enter` + `try {`
// right after the body's opening brace, and `} finally { exit }` before its
// closing brace. Block-less bodies (arrow expressions) and empty blocks are
// skipped.
function collectInsertion({ name, node }, relFile, insertions) {
  const body = node.body;
  if (!body || body.type !== 'BlockStatement' || body.body.length === 0) return;
  const key = JSON.stringify(methodKey(relFile, name));
  // Babel offsets are half-open [start, end): the braces live at body.start
  // and body.end - 1, so insert just after the opening and just before the
  // closing one.
  insertions.push({
    offset: body.start + 1,
    text: `\n  __crap_enter(${key});\n  try {`,
  });
  insertions.push({ offset: body.end - 1, text: `} finally { __crap_exit(${key}); }\n` });
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
