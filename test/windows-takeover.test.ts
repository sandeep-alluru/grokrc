/**
 * The takeover safety checks must not degrade into "proceed anyway".
 *
 * Two defects found while preparing Windows support, both in the identity check
 * that stops a phone tap killing an unrelated process:
 *
 *  1. `looksLikeGrok` split argv0 on '/' only, so a Windows path
 *     `C:\tools\grok.exe` never reduced to `grok.exe` and a genuine agent was
 *     rejected as "not a grok process".
 *
 *  2. `processArgs` shells out to `ps`, which does not exist on Windows, and
 *     returned `null` on failure. `takeOver` reads `null` as "died between the
 *     registry read and now — nothing to stop" and resumes WITHOUT killing.
 *     Conflating "it is gone" with "I could not look" means that on any machine
 *     without `ps`, takeover silently skips the safety check and puts two agents
 *     on one conversation — precisely what resume() refuses to do.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const { looksLikeGrok, processArgs } = await import('../src/daemon/session-manager.ts');

test('looksLikeGrok accepts a Windows path with backslashes', () => {
  assert.equal(looksLikeGrok('C:\\tools\\grok.exe'), true);
  assert.equal(looksLikeGrok('C:\\tools\\grok.exe agent stdio'), true);
});

test('KNOWN LIMIT: a Windows path containing spaces is not recognised', () => {
  // Asserting the CURRENT behaviour deliberately, so it is visible rather than
  // forgotten. `looksLikeGrok` takes argv0 by splitting on whitespace, so
  // `C:\Program Files\grok\grok.exe` yields `C:\Program` — and "Program Files"
  // is the normal install location on Windows.
  //
  // This cannot be fixed by pattern-matching the whole string: `sshd --config
  // /etc/grok` would then match, and this function exists precisely to stop a
  // phone tap killing an unrelated process. The real fix belongs in the Windows
  // implementation of processArgs, which must return the EXECUTABLE PATH ALONE
  // (Get-CimInstance Win32_Process -> ExecutablePath) rather than a
  // space-joined command line. See docs/WINDOWS-HANDOVER.md item 1.
  assert.equal(looksLikeGrok('C:\\Program Files\\grok\\grok.exe agent stdio'), false);
});

test('looksLikeGrok still accepts a POSIX path', () => {
  assert.equal(looksLikeGrok('/usr/local/bin/grok agent stdio'), true);
  assert.equal(looksLikeGrok('grok agent stdio'), true);
});

test('looksLikeGrok still rejects an unrelated process', () => {
  // The control. Without this, "return true" would pass the two tests above.
  assert.equal(looksLikeGrok('/usr/bin/sshd -D'), false);
  assert.equal(looksLikeGrok('C:\\Windows\\System32\\notepad.exe'), false);
  assert.equal(looksLikeGrok('/usr/bin/grokker --serve'), false);
});

test('a missing `ps` is reported as UNKNOWN, not as "the process is gone"', async () => {
  // Reproduces the Windows condition on this machine: no `ps` on PATH. The old
  // code returned null here, and takeOver reads null as "already dead".
  const realPath = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const r = await processArgs(process.pid);
    assert.equal(
      r,
      'unknown',
      'with no `ps` available the answer must be "unknown" — never a claim that the process died'
    );
  } finally {
    process.env.PATH = realPath;
  }
});

test('a genuinely absent pid is still reported as gone', async () => {
  // The other control: "unknown" must not swallow the real "it is dead" answer,
  // or takeover would refuse forever on a stale registry entry.
  const r = await processArgs(0x7ffffff0);
  assert.equal(r, null, 'a pid that does not exist must report null, meaning gone');
});
