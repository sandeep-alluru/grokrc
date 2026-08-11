/**
 * A control endpoint a test can actually bind, on this platform.
 *
 * Three test files built one as `join(tmpdir(), 'control.sock')`. Windows has no
 * Unix domain sockets and `net` will not bind a filesystem path there, so
 * `listen()` threw `EACCES` — as an UNHANDLED exception during module setup,
 * which killed the whole file rather than failing one test. That is why the
 * first Windows run showed 30 errors from three files and no assertions at all.
 *
 * Production already answers this question in `src/daemon/control.ts`: a named
 * pipe on Windows, a socket file everywhere else. This mirrors that choice for
 * tests, which additionally need a UNIQUE endpoint per call so two servers in
 * one file do not collide.
 *
 * Note for anyone extending this: a named pipe is not a file. It has no mode, no
 * stale remnant, and no directory entry, so the three tests that assert
 * file-system semantics (`chmod`, reclaiming a stale socket, `close()` unlinking
 * it) have nothing to observe on Windows and are skipped there deliberately —
 * see `POSIX_ONLY` below and its use in `test/control.test.ts`.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { IS_WINDOWS } from '../../src/daemon/control.ts';

/**
 * Reason string when a socket-file behaviour cannot exist on this platform.
 *
 * A skip must say why. `node --test` reports the string, so a Windows run
 * states what it did not measure instead of quietly counting three passes.
 */
export const POSIX_ONLY = IS_WINDOWS
  ? 'socket-file semantics: Windows uses a named pipe, which has no mode, no stale remnant and no directory entry'
  : false;

/**
 * The Windows named-pipe namespace prefix, spelled `\\.\pipe\`.
 *
 * `String.raw` deliberately, rather than a literal run of escaped backslashes:
 * the escaped form is `'\\\\.\\pipe\\'`, which is easy to miscount by one and
 * hard to review. The trailing separator is appended separately because a raw
 * literal may not end in a backslash.
 */
const PIPE_PREFIX = String.raw`\\.\pipe` + '\\';

/**
 * A bindable control endpoint.
 *
 * @param dir  a scratch directory — used as the socket's home on POSIX, and as
 *             the uniqueness seed for the pipe name on Windows.
 * @param name distinguishes several endpoints within one test file.
 */
export function controlEndpoint(dir: string, name = 'control'): string {
  if (!IS_WINDOWS) return join(dir, `${name}.sock`);
  // Pipe names are machine-global and flat, so the scratch directory — which is
  // already unique per run — is hashed in to keep concurrent runs apart.
  const seed = createHash('sha256').update(`${dir} ${name}`).digest('hex').slice(0, 16);
  return `${PIPE_PREFIX}grokrc-test-${seed}`;
}
