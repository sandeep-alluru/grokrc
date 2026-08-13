/**
 * Shared-backend (leader) mode — the laptop↔phone handoff claim.
 *
 * README says the TUI and the phone can drive the SAME session. That rested
 * entirely on `grok agent leader` behaving as advertised, and had never been
 * exercised. Probing it found a real bug: `--leader` is an option of
 * `grok agent`, not of the `stdio` subcommand, so appending it after `stdio`
 * made grok exit with "unexpected argument". The flag had never worked.
 *
 * Uses the real binary with an isolated leader socket. Sends no prompts, so it
 * costs nothing.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpClient } from '../src/acp/client.ts';
import { StdioTransport } from '../src/acp/transport.ts';
import { SessionManager } from '../src/daemon/session-manager.ts';

const workDir = await mkdtemp(join(tmpdir(), 'grokrc-leadertest-'));
const sock = join(workDir, 'leader.sock');

let leader: ChildProcess | null = null;
let available = false;

async function waitForSocket(path: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

/**
 * Refuse to spawn a real agent against the developer's own Grok history.
 *
 * `tools/isolated-test.mjs` sets GROK_HOME for `npm test`, but a file run
 * directly — `node --test test/leader.test.ts`, which is what you do while
 * debugging — inherits nothing. That is how `grokrc-leadertest-*` groups keep
 * reappearing in ~/.grok after the leak was supposedly closed: the wrapper was
 * the only control, and it does not cover the way the file is actually run.
 */
function isolatedHome(): string | null {
  const home = process.env.GROK_HOME;
  const real = join(process.env.HOME ?? homedir(), '.grok');
  if (!home || resolve(home) === resolve(real)) return null;
  return home;
}

before(async () => {
  if (!isolatedHome()) {
    // Not isolated: skip rather than write sessions into the real ~/.grok.
    available = false;
    console.log(
      '  (skipped: run via `npm test`, or set GROK_HOME — refusing to use your real ~/.grok)'
    );
    return;
  }
  try {
    leader = spawn(
      'grok',
      ['agent', 'leader', '--no-exit-on-disconnect', '--leader-socket', sock, '--no-auto-update'],
      { cwd: workDir, stdio: ['ignore', 'ignore', 'ignore'] }
    );
    // spawn() does NOT throw for a missing binary — it emits 'error'
    // asynchronously, and with no listener Node throws it as an
    // uncaughtException AFTER this hook returns. That is exactly how CI
    // failed on every run: `Error: spawn grok ENOENT` escaping a try/catch
    // that could never have caught it. Same unhandled-'error' defect already
    // fixed in AcpClient; this is its twin in a test.
    leader.on('error', () => {
      available = false;
    });
    available = await waitForSocket(sock, 30_000);

    // A socket is not a usable agent. With an isolated GROK_HOME and no cached
    // credentials the leader starts and binds, then refuses every session with
    // "Authentication required" — so `available` has to mean "can actually open
    // a session", or the tests fail for an environment reason and look like
    // product defects.
    if (available) {
      const probe = connect();
      try {
        await probe.initialize();
        await probe.newSession(workDir);
      } catch {
        available = false;
        console.log(
          '  (leader is up but cannot open a session — no credentials in this GROK_HOME)'
        );
      } finally {
        probe.close();
      }
    }
  } catch {
    available = false;
  }
});

after(async () => {
  leader?.kill();
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

function connect(): AcpClient {
  return new AcpClient({
    transport: new StdioTransport({ cwd: workDir, useLeader: true, leaderSocket: sock }),
  });
}

test('the leader process comes up and exposes its socket', async (t) => {
  if (!available) return t.skip('grok leader unavailable in this environment');
  assert.equal(available, true);
});

test('--leader and --leader-socket precede the subcommand', () => {
  // Regression guard for the real bug: `grok agent stdio --leader` exits with
  // "unexpected argument" because --leader belongs to `agent`, not `stdio`.
  const t = new StdioTransport({
    command: 'true', // no need to launch grok just to inspect argv
    cwd: workDir,
    useLeader: true,
    leaderSocket: '/tmp/x.sock',
    model: 'grok-4.5',
  });
  // This test reads argv and nothing else, so whether `true` exists is
  // irrelevant — except that spawn reports ENOENT ASYNCHRONOUSLY, after the test
  // has ended, and an 'error' with no listener is thrown by Node. On Windows
  // there is no `true`, so both argv tests failed on an uncaughtException raised
  // by a process they never intended to run.
  t.on('error', () => {});
  const argv = t.args;
  t.close();

  const stdioAt = argv.indexOf('stdio');
  const agentAt = argv.indexOf('agent');
  assert.ok(stdioAt > 0, 'stdio subcommand must be present');
  assert.ok(agentAt >= 0, 'agent command must be present');
  // --permission-mode is top-level grok, before agent.
  assert.ok(argv.indexOf('--permission-mode') < agentAt, '--permission-mode must precede agent');
  assert.ok(argv.indexOf('--leader') < stdioAt, '--leader must precede stdio');
  assert.ok(argv.indexOf('--leader-socket') < stdioAt, '--leader-socket must precede stdio');
  // --model is a stdio-level flag and must come after.
  assert.ok(argv.indexOf('--model') > stdioAt, '--model must follow stdio');
});

test('argv is unchanged when leader mode is off', () => {
  const t = new StdioTransport({ command: 'true', cwd: workDir });
  t.on('error', () => {}); // see above: async spawn ENOENT, no `true` on Windows
  const argv = t.args;
  t.close();
  // Top-level --permission-mode precedes `agent` (Grok 1.0 CLI). Leader flags off.
  assert.deepEqual(argv, ['--permission-mode', 'default', 'agent', 'stdio']);
});

test('two independent clients attach to one shared backend', async (t) => {
  if (!available) return t.skip('grok leader unavailable');

  const a = connect();
  const b = connect();
  try {
    const initA = await a.initialize();
    const initB = await b.initialize();
    assert.equal(initA.protocolVersion, 1);
    assert.equal(initB.protocolVersion, 1);

    const sessionA = await a.newSession(workDir);
    assert.ok(sessionA.sessionId);

    // The handoff claim: a session created by one client is visible to, and
    // loadable by, an entirely separate client process.
    const list = await b.listSessions();
    assert.match(JSON.stringify(list), new RegExp(sessionA.sessionId));

    await b.loadSession(sessionA.sessionId, workDir);
  } finally {
    a.close();
    b.close();
  }
});

test('SessionManager passes leader options through to the transport', async (t) => {
  if (!available) return t.skip('grok leader unavailable');

  const sessions = new SessionManager({ useLeader: true, leaderSocket: sock });
  try {
    const info = await sessions.create(workDir, { title: 'leader-session' });
    assert.equal(info.mode, 'shared');
    assert.ok(info.id);
  } finally {
    sessions.closeAll();
  }
});
