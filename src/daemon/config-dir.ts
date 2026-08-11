/**
 * Create the config directory, and make it owner-only on this platform.
 *
 * `~/.grokrc` is not scratch space. It holds:
 *
 *   vapid.json               the Web Push PRIVATE key
 *   devices.json             device records (tokens are hashed, but still)
 *   term-token               a PLAINTEXT bearer token for `grokrc term`
 *   push-subscriptions.json  every endpoint your devices can be pushed to
 *
 * Five call sites created it as `mkdir(CONFIG_DIR, { recursive: true, mode:
 * 0o700 })`. That is correct on POSIX and **silently does nothing on Windows**,
 * which ignores POSIX modes — so the directory simply inherited whatever the
 * parent had. In practice a Windows user profile is already restricted, so this
 * was a weakened defence rather than an open door; but "probably fine by
 * inheritance" is not the same claim as "owner-only", and only one of those was
 * being made in the code.
 *
 * On Windows the equivalent is an ACL: drop inherited entries and grant the
 * current user alone. `icacls` is used because Node exposes no ACL API and a
 * dependency to set one permission is not worth it.
 *
 * Cost: at most ONE `icacls` per process. The five callers all funnel through
 * here and the result is cached, because this used to be five `mkdir` calls and
 * turning each into a subprocess spawn would be a poor trade.
 */
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where grokrc keeps its own state.
 *
 * Defined HERE rather than in auth.ts, where it used to live, so that the
 * directory and the rules for creating it are one module. auth.ts re-exports it
 * for the callers that already import it from there — moving it the other way
 * would make auth.ts and this file import each other.
 */
export const CONFIG_DIR = process.env.GROKRC_HOME ?? join(homedir(), '.grokrc');

const IS_WINDOWS = process.platform === 'win32';

/** Cached so the ACL work happens once per process, not once per caller. */
let ensured: Promise<void> | null = null;

/**
 * Apply an owner-only ACL to `dir`.
 *
 * `/inheritance:r` removes inherited entries — without it a grant is additive
 * and any inherited "Users" entry survives, which is the whole thing being
 * removed. `/grant:r` replaces rather than appends. `(OI)(CI)` makes it apply
 * to files and subdirectories created later, which is the POSIX 0700 behaviour
 * being matched.
 *
 * Returns the failure reason, or null on success. Never throws: a daemon that
 * cannot tighten a permission should still start and say so, exactly as the
 * control socket does.
 */
export async function hardenWindowsAcl(dir: string): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const user = process.env.USERDOMAIN
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : (process.env.USERNAME ?? '');
    if (!user) return 'USERNAME is not set';

    await promisify(execFile)(
      'icacls',
      [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/Q'],
      { windowsHide: true }
    );
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Ensure CONFIG_DIR exists and is owner-only.
 *
 * @param dir defaults to CONFIG_DIR; parameterised so it is testable.
 */
export async function ensureConfigDir(dir: string = CONFIG_DIR): Promise<void> {
  if (dir === CONFIG_DIR && ensured) return ensured;

  const work = (async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!IS_WINDOWS) return;
    const failure = await hardenWindowsAcl(dir);
    if (failure) {
      // Loud, but not fatal — the same posture as the control socket. A user who
      // sees this can run icacls themselves; a user who sees nothing would
      // believe a guarantee that is not in force.
      console.log(`  ⚠ could not restrict ${dir} to your account: ${failure}`);
    }
  })();

  if (dir === CONFIG_DIR) ensured = work;
  return work;
}
