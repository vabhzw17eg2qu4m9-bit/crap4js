// Main-module guard, factored out of cli.js so the path-pair comparison is
// directly testable with injected values (issue #42).
//
// The naive `import.meta.url === \`file://${process.argv[1]}\`` check broke
// in two real cases:
//   - Symlinked directories (macOS /tmp -> /private/tmp, nvm/Homebrew
//     prefixes): argv[1] keeps the as-given path while import.meta.url is
//     the realpath URL, so the strings never matched and the CLI silently
//     did nothing with exit 0.
//   - Windows: the template yields `file://C:\path` (two slashes,
//     backslashes) while a correct URL is `file:///C:/path` — never equal.
//
// Fix: resolve BOTH sides to their realpaths and compare as paths. Dual
// (not one-sided) resolution keeps `--preserve-symlinks-main` working: the
// module URL stays a symlink spelling and the realpath restores the match.
// The Node-docs idiom `pathToFileURL(argv[1]).href === import.meta.url` is
// NOT a fix — pathToFileURL preserves the symlink spelling (F4).
// Any resolution failure (no argv[1], dangling path) means "not the entry".

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Filesystem path from a path or a `file:` URL string. fileURLToPath alone
 * turns `file:///C:/x` into `/C:/x` on POSIX, which would never match the
 * drive spelling — strip the slash before a drive letter instead.
 */
function toPath(p) {
  if (!p.startsWith('file:')) return p;
  const pathname = decodeURIComponent(new URL(p).pathname);
  const stripped = pathname.replace(/^\/+/, '');
  return WIN_DRIVE.test(stripped) ? stripped : fileURLToPath(p);
}

/**
 * True when two absolute paths name the same location. Case-insensitive and
 * separator-normalizing when either side is a Windows drive-letter path,
 * strict for POSIX. Accepts path-or-file-URL strings on either side so
 * drive-letter pairs are unit-testable off-Windows.
 */
export function samePath(a, b) {
  if (a == null || b == null) return false;
  const x = toPath(String(a));
  const y = toPath(String(b));
  const rel = WIN_DRIVE.test(x) || WIN_DRIVE.test(y)
    ? path.win32.relative(x, y)
    : path.relative(x, y);
  return rel === '';
}

/**
 * True when the module at `entryUrl` (pass the caller's `import.meta.url`)
 * is the process entry (`argv[1]`). The entry URL is a required argument:
 * a default would capture mainGuard.js's own URL, not the entry's. Never
 * throws: an absent argv[1] or an unresolvable path yields false.
 */
export function isMain(entryUrl, argv1 = process.argv[1]) {
  try {
    return samePath(realpathSync(toPath(entryUrl)), realpathSync(argv1));
  } catch {
    return false;
  }
}
