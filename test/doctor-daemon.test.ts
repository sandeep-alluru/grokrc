/**
 * `doctor` must report the RUNNING daemon, not a second reality.
 *
 * It used to answer every question itself: spawn an agent, load a PushService
 * off disk, read the config. Right for someone who has not started anything;
 * wrong for everyone else. Push delivery counters live in the daemon's memory
 * and are never written to disk, so a second process reads `0 sent` no matter
 * what was delivered — and it printed exactly that while the daemon had
 * delivered two.
 *
 * "0 sent" is the answer a user gets when asking whether push works. Being
 * confidently wrong there is worse than saying nothing.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const tmp = await mkdtemp(join(tmpdir(), 'grokrc-doctor-'));
process.env.GROKRC_HOME = tmp;
process.env.GROK_HOME = tmp;

const { ControlServer, CONTROL_SOCKET_PATH } = await import('../src/daemon/control.ts');
const CLI = resolve(import.meta.dirname, '../src/cli.ts');
// The DEFAULT endpoint, not a bespoke one: `runDoctor()` spawns the real CLI,
// which computes this itself from GROKRC_HOME. Binding anything else would mean
// the child looked for a daemon at one address while the test served another —
// on POSIX both spellings happened to be `<tmp>/control.sock`, which is why a
// hardcoded path survived. It is a named pipe on Windows, and the two differ.
// GROKRC_HOME is a fresh mkdtemp above, so this is already unique per run.
const SOCK = CONTROL_SOCKET_PATH;

/** A daemon that reports counters no disk-reading process could invent. */
const LIVE = {
  pid: 4242,
  host: '10.0.0.9',
  port: 4319,
  devices: 7,
  connected: 3,
  sessions: 5,
  push: 2,
  pushStats: { sent: 41, failed: 1, expired: 0 },
  pushLastError: null,
};

const control = new ControlServer(
  {
    pair: () => ({ code: 'AAAAAA', expiresAt: Date.now() + 60_000 }),
    devices: () => [],
    revoke: async () => false,
    revokeAll: async () => 0,
    status: () => LIVE,
  },
  SOCK
);
await control.listen();

after(async () => {
  await control.close();
  await rm(tmp, { recursive: true, force: true });
});

async function runDoctor(): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', CLI, 'doctor'],
      { env: { ...process.env, GROKRC_HOME: tmp, PATH: '/usr/bin:/bin' }, timeout: 60_000 }
    );
    return stdout + stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

test('doctor reports the running daemon and its live counters', async () => {
  const out = await runDoctor();

  assert.match(out, /daemon running \(pid 4242\)/, `doctor did not report the daemon:\n${out}`);
  assert.match(out, /10\.0\.0\.9:4319/, 'the address the daemon is actually serving on');
  assert.match(out, /5 live session\(s\)/, 'live session count');
  assert.match(out, /3\/7 device\(s\) connected/, 'connected vs paired devices');

  // The decisive one: 41 sent cannot be read from disk. Reporting 0 here is the
  // defect this test exists for.
  assert.match(
    out,
    /41 sent/,
    `doctor reported disk state instead of the daemon's live delivery counters:\n${out}`
  );
  assert.doesNotMatch(
    out,
    /subscriber\(s\) on disk/,
    'the disk fallback ran despite a live daemon'
  );
});
