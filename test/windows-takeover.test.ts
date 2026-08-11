/**
 * The takeover safety checks must not degrade into "proceed anyway".
 *
 * Three defects in the identity check that stops a phone tap killing an
 * unrelated process:
 *
 *  1. `looksLikeGrok` split argv0 on '/' only, so a Windows path
 *     `C:\tools\grok.exe` never reduced to `grok.exe` and a genuine agent was
 *     rejected as "not a grok process".
 *
 *  2. `processArgs` shelled out to `ps`, which does not exist on Windows, and
 *     returned `null` on failure. `takeOver` reads `null` as "died between the
 *     registry read and now — nothing to stop" and resumes WITHOUT killing.
 *     Conflating "it is gone" with "I could not look" means that on any machine
 *     without `ps`, takeover silently skips the safety check and puts two agents
 *     on one conversation — precisely what resume() refuses to do.
 *
 *  3. The fix proposed for (2) in docs/WINDOWS-HANDOVER.md §3.1 — return the
 *     executable path alone — was necessary and NOT sufficient. The handover
 *     claims "with a clean path and no arguments, the existing separator
 *     handling already works". It does not: `looksLikeGrok` word-splits before
 *     it ever looks at separators, so the clean path
 *     `C:\Program Files\grok\grok.exe` still reduces to `C:\Program`. Measured
 *     below. The predicate had to stop splitting as well, which is why
 *     `looksLikeGrokExe` exists as a separate function rather than as a
 *     loosening of `looksLikeGrok` — a predicate that accepts both shapes would
 *     accept `vim /home/me/grok`.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const { looksLikeGrok, looksLikeGrokExe, processArgs } =
  await import('../src/daemon/session-manager.ts');

const IS_WINDOWS = process.platform === 'win32';

/* ─── looksLikeGrok: a COMMAND LINE, argv[0] only ─────────────────────────── */

test('looksLikeGrok accepts a Windows path with backslashes', () => {
  assert.equal(looksLikeGrok('C:\\tools\\grok.exe'), true);
  assert.equal(looksLikeGrok('C:\\tools\\grok.exe agent stdio'), true);
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

test('looksLikeGrok cannot read a path with spaces — which is why it is not used on Windows', () => {
  // Asserting the limit deliberately: this is a COMMAND LINE predicate, and a
  // command line containing `C:\Program Files\grok\grok.exe` genuinely has no
  // unambiguous split point. It is not fixable here, and pattern-matching the
  // whole string instead would accept `vim /home/me/grok`. takeOver uses
  // looksLikeGrokExe on Windows for exactly this reason.
  assert.equal(looksLikeGrok('C:\\Program Files\\grok\\grok.exe agent stdio'), false);
  assert.equal(looksLikeGrok('C:\\Program Files\\grok\\grok.exe'), false);
});

/* ─── looksLikeGrokExe: a PATH, no splitting ──────────────────────────────── */

test('looksLikeGrokExe accepts the normal Windows install location', () => {
  // The case the whole Windows takeover path turns on: `Program Files` contains
  // a space, and it is where Grok installs.
  assert.equal(looksLikeGrokExe('C:\\Program Files\\grok\\grok.exe'), true);
  assert.equal(looksLikeGrokExe('C:\\Users\\Someone With Spaces\\.grok\\bin\\grok.exe'), true);
});

test('looksLikeGrokExe accepts plain paths on either platform', () => {
  assert.equal(looksLikeGrokExe('C:\\tools\\grok.exe'), true);
  assert.equal(looksLikeGrokExe('/usr/local/bin/grok'), true);
  assert.equal(looksLikeGrokExe('grok'), true);
});

test('looksLikeGrokExe rejects an unrelated executable', () => {
  // The control again — and the reason this is a separate function rather than
  // a looser `looksLikeGrok`. A predicate that scanned the whole string would
  // accept the last two of these.
  assert.equal(looksLikeGrokExe('C:\\Windows\\System32\\notepad.exe'), false);
  assert.equal(looksLikeGrokExe('/usr/bin/sshd'), false);
  assert.equal(looksLikeGrokExe('/usr/bin/grokker'), false);
  assert.equal(looksLikeGrokExe('vim /home/me/grok.md'), false);
  assert.equal(looksLikeGrokExe(''), false);
});

/* ─── processArgs: the three answers must stay distinct ───────────────────── */

test('a process table that cannot be read is UNKNOWN, not "the process is gone"', async () => {
  // Removes the tool processArgs depends on — `ps` on POSIX, `powershell.exe`
  // on Windows — by emptying PATH. The old code returned null here, and
  // takeOver reads null as "already dead" and resumes without killing.
  const realPath = process.env.PATH;
  process.env.PATH = IS_WINDOWS ? 'C:\\nonexistent' : '/nonexistent';
  try {
    const r = await processArgs(process.pid);
    assert.equal(
      r,
      'unknown',
      'with no way to read the process table the answer must be "unknown" — never a claim that the process died'
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

test('this very process reads back as itself, and is identified', async () => {
  // The end-to-end shape check: whatever processArgs returns for a real, live
  // pid on THIS platform must be something the matching predicate understands.
  // Without it, the two halves could drift apart — a path returned and a
  // command line matched — and every takeover would refuse.
  const r = await processArgs(process.pid);
  assert.ok(r && r !== 'unknown', `expected to read this process, got: ${r}`);
  const identify = IS_WINDOWS ? looksLikeGrokExe : looksLikeGrok;
  // It is node, not grok — so the predicate must say NO, and must do so by
  // reading a real value rather than by failing to read anything.
  assert.equal(identify(r!), false, `node should not identify as grok, from: ${r}`);
  assert.match(r!, /node/i, `expected the running executable to be named, got: ${r}`);
});
