/**
 * `~/.grokrc` must be readable by you and nobody else.
 *
 * It holds the Web Push PRIVATE key, the device store, and — for `grokrc term`
 * — a PLAINTEXT bearer token. Five call sites asked for `mode: 0o700`, which
 * Windows ignores, so on that platform the claim in the code was not a claim
 * about anything.
 *
 * These tests assert the OUTCOME on whichever platform they run on, read back
 * from the operating system, rather than asserting that a function was called.
 * A test that only checked "ensureConfigDir did not throw" would pass with the
 * whole hardening step deleted.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const { ensureConfigDir } = await import('../src/daemon/config-dir.ts');

const IS_WINDOWS = process.platform === 'win32';

test('it creates the directory when missing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'grokrc-cfgdir-'));
  const dir = join(base, 'nested', '.grokrc');
  try {
    await ensureConfigDir(dir);
    assert.equal((await stat(dir)).isDirectory(), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('it is idempotent on a directory that already exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'grokrc-cfgdir-'));
  try {
    await ensureConfigDir(dir);
    await ensureConfigDir(dir); // must not throw the second time
    assert.equal((await stat(dir)).isDirectory(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'POSIX: the directory is owner-only',
  { skip: IS_WINDOWS ? 'POSIX modes are meaningless on Windows' : false },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grokrc-cfgdir-'));
    try {
      await ensureConfigDir(dir);
      const mode = (await stat(dir)).mode & 0o777;
      assert.equal(mode & 0o077, 0, `group/world bits set (mode ${mode.toString(8)})`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  'Windows: inherited access is removed and only this account is granted',
  { skip: IS_WINDOWS ? false : 'Windows ACLs only exist on Windows' },
  async () => {
    // The condition has to be CREATED, not assumed. %TEMP% carries no
    // BUILTIN\Users entry, so asserting "Users is absent" on a plain temp
    // directory passes whether or not anything was hardened — measured: with
    // `/inheritance:r` removed the first version of this test still passed, and
    // verify-guards reported the control unproven.
    //
    // So: give a PARENT an inheritable grant to BUILTIN\Users, create the
    // config directory inside it, and require that hardening removes what the
    // child inherited.
    const parent = await mkdtemp(join(tmpdir(), 'grokrc-cfgparent-'));
    const dir = join(parent, '.grokrc');
    try {
      await execFileAsync('icacls', [parent, '/grant', '*S-1-5-32-545:(OI)(CI)R'], {
        windowsHide: true,
      });

      await ensureConfigDir(dir);
      const { stdout } = await execFileAsync('icacls', [dir], { windowsHide: true });

      // S-1-5-32-545 is BUILTIN\Users, matched by SID so this does not depend
      // on the machine's display language.
      const inherited = await execFileAsync('icacls', [parent], { windowsHide: true });
      assert.match(inherited.stdout, /S-1-5-32-545|Users/i, 'precondition: the parent grants Users');

      assert.doesNotMatch(stdout, /\bEveryone:/i, `Everyone still has access:\n${stdout}`);
      assert.doesNotMatch(
        stdout,
        /(BUILTIN\\Users|S-1-5-32-545)/i,
        `the child inherited Users access and hardening did not remove it:\n${stdout}`
      );

      const me = process.env.USERNAME ?? '';
      assert.ok(me, 'precondition: USERNAME is set');
      assert.match(
        stdout,
        new RegExp(me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        `the owning account should still be granted access:\n${stdout}`
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
);
