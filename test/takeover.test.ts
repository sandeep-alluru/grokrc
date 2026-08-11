/**
 * Taking a session over from the terminal process that owns it.
 *
 * This is the only operation in grokrc that KILLS something, and it is reachable
 * from a phone. The danger is not the kill itself — it is *which* pid gets killed.
 *
 * Grok records owners in `~/.grok/active_sessions.json`. That file can name a pid
 * that has since died, and the OS recycles pids. `process.kill(pid, 0)` — the
 * liveness probe the session manager already uses — answers "alive" for ANY
 * process, so a stale entry plus pid reuse points takeover at something innocent.
 *
 * These tests spawn REAL processes and assert the bystander survives.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const grokHome = await mkdtemp(join(tmpdir(), 'grokrc-takeover-grok-'));
process.env.GROK_HOME = grokHome;
process.env.GROKRC_HOME = await mkdtemp(join(tmpdir(), 'grokrc-takeover-'));

const { SessionManager, looksLikeGrok, looksLikeGrokExe, processArgs } =
  await import('../src/daemon/session-manager.ts');

const spawned: ChildProcess[] = [];

const IS_WINDOWS = process.platform === 'win32';

/**
 * Scratch directory holding the fake agents Windows needs as real files.
 *
 * The SPACE in the name is deliberate and load-bearing: Grok installs to
 * `C:\Program Files\grok` by default, and the original Windows defect was that
 * a space in the path made a genuine agent unrecognisable. A temp directory
 * without one would exercise the easy case and report success.
 */
const fakeBin = await mkdtemp(join(tmpdir(), 'grokrc takeover bin '));

/**
 * A live process that identifies itself as exactly `name`. Real, not a stub.
 *
 * The two platforms need different tricks because they answer "what is this
 * process?" differently, and the difference is the point of the test:
 *
 *   POSIX    `ps` reports argv[0], which `exec -a` can set to anything. That is
 *            precisely why takeOver cannot trust a name alone on a stale pid.
 *   Windows  there is no argv[0] to spoof — the process table reports the
 *            EXECUTABLE PATH, which is a fact about a file on disk. So the fake
 *            agent has to be a real executable with the right filename. A copy
 *            of ping.exe is used: present on every Windows install, tiny, and
 *            it will sit for minutes on request.
 *
 * The Windows form is the stronger of the two — it cannot be spoofed, only
 * named — which is worth knowing when reading the guarantees this test claims.
 */
function spawnAs(name: string): ChildProcess {
  let p: ChildProcess;
  if (IS_WINDOWS) {
    const exe = join(fakeBin, `${name}.exe`);
    if (!existsSync(exe)) {
      copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), exe);
    }
    // -n 300: one ping a second for five minutes. Longer than any test here.
    p = spawn(exe, ['-n', '300', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  } else {
    p = spawn('bash', ['-c', `exec -a ${name} sleep 300`], { stdio: 'ignore' });
  }
  // An unhandled 'error' on a ChildProcess is thrown by Node. Even when the
  // binary is certain to exist, a missing listener turns any spawn failure
  // into a dead test runner instead of a failed test.
  p.on('error', () => {});
  spawned.push(p);
  return p;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Point Grok's registry at a pid, as a running TUI would. */
async function registerOwner(sessionId: string, pid: number, cwd: string): Promise<void> {
  await writeFile(
    join(grokHome, 'active_sessions.json'),
    JSON.stringify([{ session_id: sessionId, pid, cwd }])
  );
}

/** takeOver() only resumes sessions that exist on disk. */
async function persistSession(id: string, cwd: string): Promise<void> {
  await mkdir(join(grokHome, 'sessions', encodeURIComponent(cwd), id), { recursive: true });
}

before(async () => {
  await mkdir(grokHome, { recursive: true });
});

after(async () => {
  for (const p of spawned) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await rm(grokHome, { recursive: true, force: true });
  await rm(process.env.GROKRC_HOME!, { recursive: true, force: true });
  await rm(fakeBin, { recursive: true, force: true });
});

/* ─── the pid guard ───────────────────────────────────────────────────────── */

test('looksLikeGrok trusts argv[0] only', () => {
  for (const ok of ['grok', '/usr/bin/grok', 'grok --resume abc', '/opt/x/grok -p "hi"']) {
    assert.equal(looksLikeGrok(ok), true, `should accept: ${ok}`);
  }
  for (const no of [
    'sleep 300',
    'node server.js',
    'vim grok.md', // contains "grok" — argv[0] does not
    'grokrc up', // a different program
    'grokfoo',
    'python3 -m grok',
    '',
  ]) {
    assert.equal(looksLikeGrok(no), false, `should reject: ${no}`);
  }
});

test('processArgs reads a real process, and null once it is gone', async () => {
  const p = spawnAs('grok');
  await new Promise((r) => setTimeout(r, 200));

  const args = await processArgs(p.pid!);
  assert.ok(args, 'should read the identity of a live process');
  // The predicate has to match the SHAPE processArgs returns on this platform:
  // a command line from `ps`, an executable path from the Windows process
  // table. Using looksLikeGrok on Windows fails here whenever the path contains
  // a space — which `fakeBin` deliberately does, because `C:\Program Files` is
  // where Grok installs. That is the same mismatch takeOver dispatches around.
  const identify = IS_WINDOWS ? looksLikeGrokExe : looksLikeGrok;
  assert.equal(identify(args!), true, `expected a grok-looking identity, got: ${args}`);

  p.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await processArgs(p.pid!), null, 'a dead pid should read back as null');
});

/* ─── the safety case ─────────────────────────────────────────────────────── */

test('a recycled pid is NOT killed — the bystander survives', async () => {
  // Exactly the dangerous shape: the registry names a live pid that is not grok.
  const bystander = spawnAs('definitely-not-grok');
  await new Promise((r) => setTimeout(r, 200));

  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const cwd = '/tmp';
  await persistSession(id, cwd);
  await registerOwner(id, bystander.pid!, cwd);

  const sessions = new SessionManager({});
  await assert.rejects(
    () => sessions.takeOver(id, cwd, { waitMs: 500 }),
    /not a grok process/,
    'takeover must refuse a pid that is not grok'
  );

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    alive(bystander.pid!),
    true,
    'THE BYSTANDER WAS KILLED — a stale registry entry can take out an unrelated process'
  );
  bystander.kill('SIGKILL');
});

test('the daemon refuses to terminate itself', async () => {
  const id = 'ffffffff-1111-2222-3333-444444444444';
  const cwd = '/tmp';
  await persistSession(id, cwd);
  await registerOwner(id, process.pid, cwd);

  const sessions = new SessionManager({});
  await assert.rejects(
    () => sessions.takeOver(id, cwd, { waitMs: 500 }),
    /the grokrc daemon itself/
  );
  assert.equal(alive(process.pid), true);
});

/* ─── the happy path ──────────────────────────────────────────────────────── */

test('a grok-looking owner is stopped with SIGTERM', async () => {
  const owner = spawnAs('grok');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(owner.pid!), true, 'precondition: the owner is running');

  const id = '11111111-2222-3333-4444-555555555555';
  const cwd = '/tmp';
  await persistSession(id, cwd);
  await registerOwner(id, owner.pid!, cwd);

  // resume() spawns a real `grok agent stdio`, which is not what this test is
  // about — it asserts the process was stopped, so a failing resume afterwards
  // is expected and irrelevant.
  const sessions = new SessionManager({});
  await sessions.takeOver(id, cwd, { waitMs: 5_000 }).catch(() => {});

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(owner.pid!), false, 'the owning grok process should have been stopped');
});

test('a session nobody owns is taken over without killing anything', async () => {
  const bystander = spawnAs('grok'); // live, but NOT in the registry
  await new Promise((r) => setTimeout(r, 200));

  const id = '99999999-8888-7777-6666-555555555555';
  const cwd = '/tmp';
  await persistSession(id, cwd);
  await writeFile(join(grokHome, 'active_sessions.json'), '[]');

  const sessions = new SessionManager({});
  await sessions.takeOver(id, cwd, { waitMs: 500 }).catch(() => {});

  assert.equal(alive(bystander.pid!), true, 'an unrelated grok process must not be touched');
  bystander.kill('SIGKILL');
});

test('takeOver validates its inputs before signalling anything', async () => {
  const sessions = new SessionManager({});
  await assert.rejects(() => sessions.takeOver('../../etc/passwd', '/tmp'), /session/i);
  await assert.rejects(
    () => sessions.takeOver('11111111-2222-3333-4444-555555555555', 'rel'),
    /absolute/
  );
});
