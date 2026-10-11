// Digest-incremental mutation cache ("killed-stays-killed"), port of
// crap4dart 16d9c4c's lib/src/gates/mutation_cache.dart (spec §11.23).
// Per-method outcomes are keyed by the method's source-text digest: a
// killed mutant of an UNCHANGED method is replayed from
// `.crap-mutation-cache.json` instead of re-executed; survivors are always
// re-executed (the suite may have improved), and coverage gating is
// re-derived from fresh coverage every run. The envelope carries a meta
// fingerprint (tool version, operators, test_args) — any mismatch, corrupt
// file, or version change wipes the cache into a full re-execution.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Written under the scanned project root.
export const MUTATION_CACHE_FILE_NAME = '.crap-mutation-cache.json';

// Cache envelope version; a mismatch discards the file.
export const MUTATION_CACHE_VERSION = 1;

// FNV-1a over a 64-bit state, output-masked to 63 bits (mirrors the Dart
// implementation), as 16 hex chars — zero dependencies, stable across
// platforms/runs.
export function fnv1a64Hex(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x1000001b3n;
  const mask = 0x7fffffffffffffffn;
  for (const byte of Buffer.from(text, 'utf8')) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

// The tool side of the meta fingerprint: the cache must distinguish the
// tool version that produced cached verdicts, so `crap4js <version>` is
// read once from the tool's own package.json (not the scanned project's).
let toolVersion;
function currentToolVersion() {
  if (toolVersion === undefined) {
    toolVersion = createRequire(import.meta.url)('../package.json').version;
  }
  return toolVersion;
}

// Mutation-relevant configuration fingerprint. Stored in the cache
// envelope; any mismatch wipes the cache because cached outcomes were
// produced under different semantics.
export function cacheMetaCurrent(operators, testArgs) {
  return {
    tool: `crap4js ${currentToolVersion()}`,
    operators: [...operators].sort().join(','),
    test_args: testArgs.join(','),
  };
}

function metaMatches(stored, current) {
  return stored.tool === current.tool &&
    stored.operators === current.operators &&
    stored.test_args === current.test_args;
}

// Stable cache key of a method: relative file path plus the extracted
// method name (two methods may share a name across files — the file path
// keeps them distinct).
export function methodsKey(relPath, methodName) {
  return `${relPath}#${methodName}`;
}

// The digest-incremental cache: per-method outcomes keyed by source-text
// digest. Only `killed` outcomes are replayable; survivors and timeouts
// always re-execute.
export class MutationCache {
  constructor(meta, methods = {}) {
    this.meta = meta;
    this.methods = methods;
  }

  // Returns the cached `killed` outcome matching `site` when the stored
  // digest equals `ref.digest`; null means the mutant must be executed
  // (changed method, unknown site, or a survivor). Stored offsets are
  // relative to the method start, so an edit in an earlier method of the
  // same file never shifts later methods' site identities.
  replayKill(ref, site) {
    const method = this.methods[ref.key];
    if (!method || method.digest !== ref.digest) return null;
    return method.outcomes.find((o) =>
      o.status === 'killed' &&
      o.offset === site.offset - ref.start &&
      o.category === site.category &&
      o.original === site.original &&
      o.mutant === site.mutant,
    ) ?? null;
  }

  // Merges one run's `fresh` outcomes into the cache: methods seen this
  // run get their current digest plus the union of fresh and still-valid
  // old outcomes; methods absent from `liveKeys` (deleted or excluded
  // files) are pruned.
  mergeRun(fresh, liveKeys) {
    for (const key of Object.keys(this.methods)) {
      if (!liveKeys.has(key)) delete this.methods[key];
    }
    for (const [key, entry] of fresh) {
      const kept = (this.methods[key]?.outcomes ?? [])
        .filter((o) => !entry.outcomes.some((f) => sameSite(f, o)));
      this.methods[key] = { digest: entry.digest, outcomes: [...entry.outcomes, ...kept] };
    }
  }

  // JSON envelope: `{version, meta, methods}`.
  envelope() {
    return { version: MUTATION_CACHE_VERSION, meta: this.meta, methods: this.methods };
  }

  save(path) {
    writeFileSync(path, `${JSON.stringify(this.envelope(), null, 2)}\n`);
  }

  // A missing, corrupt, outdated or meta-mismatched file yields an empty
  // cache — a full re-execution under the current semantics.
  static load(path, meta) {
    if (!existsSync(path)) return new MutationCache(meta);
    try {
      const decoded = JSON.parse(readFileSync(path, 'utf8'));
      if (decoded?.version !== MUTATION_CACHE_VERSION) return new MutationCache(meta);
      if (!metaMatches(decoded.meta ?? {}, meta)) return new MutationCache(meta);
      return new MutationCache(meta, readMethods(decoded.methods));
    } catch {
      // SyntaxError from JSON.parse — a corrupt file means full re-execution.
      return new MutationCache(meta);
    }
  }
}

function readMethods(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key, value]) => typeof key === 'string' && value && typeof value === 'object')
      .map(([key, value]) => [key, readMethod(value)]),
  );
}

// Malformed fields fall back to values that can never replay: an empty
// digest matches no live method digest, and non-killed/absent outcomes are
// never replayed by replayKill.
function readMethod(value) {
  return {
    digest: typeof value.digest === 'string' ? value.digest : '',
    outcomes: Array.isArray(value.outcomes) ? value.outcomes : [],
  };
}

function sameSite(a, b) {
  return a.offset === b.offset && a.category === b.category &&
    a.original === b.original && a.mutant === b.mutant;
}
