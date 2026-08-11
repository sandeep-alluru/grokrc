/**
 * Path containment — the one question four different guards were all asking,
 * and all four were getting wrong off POSIX.
 *
 * Every one of them was written as `resolve(target).startsWith(resolve(root) + '/')`.
 * On Windows `resolve()` returns `C:\...`, so the `+ '/'` suffix never matches and
 * the check refuses everything. Measured on Windows before this module existed:
 *
 *   · `src/daemon/server.ts`  — every static asset returned 403. `GET /`, `/app.js`,
 *     `/sw.js` and `/manifest.webmanifest` all `{"error":"forbidden"}`, so the PWA
 *     could not load at all and the product was unusable.
 *   · `src/relay/server.ts`   — the same, for the relay-served client.
 *   · `src/daemon/session-manager.ts` — `observe()` threw "resolved outside the
 *     session store" for a legitimate session, so observed mode was dead.
 *   · `src/cli.ts`            — `removeSessionDir()` returned early instead of
 *     deleting, so every `doctor` run leaked a throwaway session directory.
 *
 * All four failed CLOSED — they denied legitimate access rather than allowing an
 * escape — so this was a functionality break, not a security hole. That is the
 * only reason it was survivable long enough to reach here.
 *
 * `relative()` is used rather than a separator-aware `startsWith`, because it is
 * the platform's own answer to "how do I get from root to target": a path that
 * escapes comes back beginning `..`, and one on a different Windows drive comes
 * back absolute. Both are rejected. It is also case-insensitive on win32, which a
 * string compare of `C:\Users` against `c:\users` is not.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Is `target` the directory `root` itself, or something beneath it?
 *
 * Both are resolved first, so `..` segments are collapsed before the comparison
 * rather than being compared as text.
 */
export function isInside(root: string, target: string): boolean {
  const r = resolve(root);
  const t = resolve(target);
  if (t === r) return true;

  const rel = relative(r, t);
  // '' means identical (already handled). '..' or '..<sep>…' means it climbed out.
  // An absolute result means there is no relative route at all — a different
  // drive or UNC root on Windows.
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;
  return true;
}

/** `isInside`, but the target must be strictly beneath `root` — never root itself. */
export function isStrictlyInside(root: string, target: string): boolean {
  return resolve(root) !== resolve(target) && isInside(root, target);
}
