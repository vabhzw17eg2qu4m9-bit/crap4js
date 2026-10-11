import test from 'node:test';
import assert from 'node:assert';
import { diffIntersects, gitChangedLines, parseDiffLineMap } from '../src/diffLines.js';

const DIFF = `diff --git a/src/a.js b/src/a.js
index 3f1a..b2c 100644
--- a/src/a.js
+++ b/src/a.js
@@ -2 +2 @@
-  return 1;
+  return 2;
@@ -10,2 +11,3 @@
   keep();
+  more();
+  again();
diff --git a/src/gone.js b/src/gone.js
deleted file mode 100644
index 11..00
--- a/src/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-export const dead = 1;
diff --git a/src/new.js b/src/new.js
new file mode 100644
index 00..11
--- /dev/null
+++ b/src/new.js
@@ -0,0 +1 @@
+export const fresh = 1;
`;

test('parseDiffLineMap: hunks, count ranges, deleted and new files', () => {
  const map = parseDiffLineMap(DIFF);
  // `@@ -2 +2 @@` (count defaults to 1) and `@@ -10,2 +11,3 @@` (three
  // added lines starting at 11).
  assert.deepEqual([...map.get('src/a.js')], [2, 11, 12, 13]);
  assert.equal(map.has('src/gone.js'), false, 'deleted files are absent');
  assert.deepEqual([...map.get('src/new.js')], [1]);
});

test('diffIntersects: range intersection on the changed-line set', () => {
  const map = parseDiffLineMap(DIFF);
  assert.equal(diffIntersects(map, 'src/a.js', 1, 3), true, 'hits changed line 2');
  assert.equal(diffIntersects(map, 'src/a.js', 11, 13), true, 'whole range changed');
  assert.equal(diffIntersects(map, 'src/a.js', 3, 10), false);
  assert.equal(diffIntersects(map, 'src/absent.js', 1, 99), false, 'files outside the diff never intersect');
});

test('gitChangedLines: fixed argv over the scanned paths, parsed result, git failure', () => {
  const calls = [];
  const map = gitChangedLines('HEAD', ['src/a.js', 'src/b.js'], '/proj', (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: DIFF, stderr: '' };
  });
  assert.deepEqual(calls, [{
    cmd: 'git',
    args: ['diff', '--unified=0', 'HEAD', '--', 'src/a.js', 'src/b.js'],
    opts: { cwd: '/proj', encoding: 'utf8' },
  }]);
  assert.equal(map.get('src/a.js').has(2), true);
  assert.throws(
    () => gitChangedLines('nope', [], '/proj', () => ({ status: 128, stdout: '', stderr: 'unknown revision or path not in the working tree' })),
    /git diff nope failed: unknown revision/,
  );
});
