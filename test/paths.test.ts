/**
 * Path containment, the check four guards share.
 *
 * The interesting half is the REFUSAL. A test that only asserts "a file inside
 * the root is inside the root" passes with the containment check deleted
 * entirely, which is the defect this repo keeps finding in its own gates. So
 * every allow case below is paired with an escape that must be refused.
 *
 * The bug this module was extracted for: all four call sites tested containment
 * with `resolve(target).startsWith(resolve(root) + '/')`. On Windows `resolve()`
 * yields `C:\...`, the `+ '/'` never matches, and the check refused everything —
 * the daemon 403'd every asset of its own PWA, observed mode threw on legitimate
 * sessions, and `doctor` stopped cleaning up after itself. All four failed
 * closed, so the platform was unusable rather than unsafe.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join, resolve, sep } from 'node:path';

const { isInside, isStrictlyInside } = await import('../src/paths.ts');

/* ─── the allow half ──────────────────────────────────────────────────────── */

test('a file directly inside the root is inside it', () => {
  const root = resolve('web');
  assert.equal(isInside(root, join(root, 'app.js')), true);
});

test('a file nested several levels down is inside it', () => {
  const root = resolve('docs');
  assert.equal(isInside(root, join(root, 'captures', 'e2e-drive.json')), true);
});

test('the root itself counts as inside, but not strictly inside', () => {
  const root = resolve('web');
  assert.equal(isInside(root, root), true);
  assert.equal(isStrictlyInside(root, root), false);
});

/**
 * The regression that motivated the module. This is the whole point on Windows:
 * a native absolute path must be recognised as contained. Under the old
 * `startsWith(root + '/')` form this was false on win32 and true on POSIX, which
 * is why the suite was green for two years and the platform was broken.
 */
test('a NATIVE absolute path is contained on whatever platform this is', () => {
  const root = resolve('web');
  const target = resolve('web', 'app.js');
  assert.ok(target.startsWith(root), 'precondition: resolve() agrees these share a prefix');
  assert.equal(
    isInside(root, target),
    true,
    `a resolved child of a resolved root must be inside it (sep=${JSON.stringify(sep)})`
  );
});

/* ─── the refusal half — the part that must not regress ───────────────────── */

test('a sibling directory sharing a name prefix is NOT inside', () => {
  // The classic off-by-one in prefix matching: `/srv/webroot` must not count as
  // inside `/srv/web`. This is why the separator is part of the comparison.
  assert.equal(isInside(resolve('web'), resolve('web-not-really')), false);
});

test('climbing out with .. is refused', () => {
  const root = resolve('web');
  assert.equal(isInside(root, join(root, '..', 'package.json')), false);
  assert.equal(isInside(root, join(root, '..', '..', 'etc', 'passwd')), false);
});

test('the parent of the root is refused', () => {
  const root = resolve('web');
  assert.equal(isInside(root, resolve(root, '..')), false);
});

test('a path that climbs out and back in is allowed, because it lands inside', () => {
  // resolve() collapses it first, so this is genuinely `web/app.js`. Asserting
  // it deliberately: the check is about where the path LANDS, not how it reads.
  const root = resolve('web');
  assert.equal(isInside(root, join(root, '..', 'web', 'app.js')), true);
});

test('an unrelated absolute path is refused', () => {
  const root = resolve('web');
  assert.equal(isInside(root, resolve(sep === '\\' ? 'C:\\Windows\\System32' : '/etc')), false);
});

test('a different Windows drive is refused', () => {
  // On win32 `relative()` returns an absolute path when there is no route
  // between two roots. On POSIX this string is simply a relative name, which
  // resolve() anchors under cwd — outside `web` either way.
  assert.equal(isInside(resolve('web'), 'Z:\\somewhere\\else'), false);
});
