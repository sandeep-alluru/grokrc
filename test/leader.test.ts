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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

before(async () => {
  try {
    leader = spawn(
      'grok',
      ['agent', 'leader', '--no-exit-on-disconnect', '--leader-socket', sock, '--no-auto-update'],
      { cwd: workDir, stdio: ['ignore', 'ignore', 'ignore'] }
    );
    available = await waitForSocket(sock, 30_000);
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
  const argv = t.args;
  t.close();

  const stdioAt = argv.indexOf('stdio');
  assert.ok(stdioAt > 0, 'stdio subcommand must be present');
  assert.ok(argv.indexOf('--leader') < stdioAt, '--leader must precede stdio');
  assert.ok(argv.indexOf('--leader-socket') < stdioAt, '--leader-socket must precede stdio');
  // --model is a stdio-level flag and must come after.
  assert.ok(argv.indexOf('--model') > stdioAt, '--model must follow stdio');
});

test('argv is unchanged when leader mode is off', () => {
  const t = new StdioTransport({ command: 'true', cwd: workDir });
  const argv = t.args;
  t.close();
  assert.deepEqual(argv, ['agent', 'stdio']);
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
