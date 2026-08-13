/**
 * Hand-back must free the session and return usable resume commands.
 *
 * Two failures users hit on Linux and Windows:
 *  1. Daemon returned a bash-only `cd … && grok -r` line (broken in PowerShell).
 *  2. Daemon answered before the agent pid exited, so `grok -r` still saw a live
 *     owner and refused.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-release-'));
process.env.GROKRC_HOME = tmp;
process.env.GROK_HOME = tmp;

const { SessionManager, resumeCommands } = await import('../src/daemon/session-manager.ts');

const SESSION_ID = '019fabcd-0000-7000-8000-00000000rel';

class QuietTransport extends EventEmitter {
  pid = 42_424; // fake — release only waits if kill(0) succeeds; this pid is gone
  send(msg: any): void {
    const reply = (result: unknown) =>
      queueMicrotask(() => this.emit('message', { jsonrpc: '2.0', id: msg.id, result }));
    if (msg.method === 'initialize') {
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    }
    if (msg.method === 'session/new') return reply({ sessionId: SESSION_ID });
    if (msg.method === 'session/load') return reply({});
    if (msg.id !== undefined) reply({});
  }
  close(): void {
    this.emit('close', { code: 0 });
  }
}

test('resumeCommands covers bash and PowerShell', () => {
  const c = resumeCommands(`C:\\Users\\me\\My Project`, 'abc-123');
  assert.match(c.bash, /cd '/);
  assert.match(c.bash, /grok -r abc-123/);
  assert.match(c.powershell, /Set-Location/);
  assert.match(c.powershell, /grok -r abc-123/);
  assert.match(c.term, /grokrc term --session abc-123/);
  // Paths with spaces must stay quoted.
  assert.match(c.powershell, /My Project/);
});

test('release refuses a session the daemon does not own', async () => {
  const sessions = new SessionManager({
    transportFactory: () => new QuietTransport() as never,
  });
  await assert.rejects(() => sessions.release('019fabcd-0000-7000-8000-00000000nope'), /not owned/);
});

test('release closes an owned session and returns resume commands', async () => {
  await mkdir(join(tmp, 'sessions', encodeURIComponent(tmp), SESSION_ID), {
    recursive: true,
  });
  const sessions = new SessionManager({
    transportFactory: () => new QuietTransport() as never,
  });
  try {
    // Resume from disk so we own SESSION_ID under cwd=tmp.
    await sessions.resume(SESSION_ID, tmp);
    assert.ok(sessions.get(SESSION_ID), 'precondition: owned');

    // Skip OS terminal spawn in unit tests (no display needed).
    const result = await sessions.release(SESSION_ID, { relaunch: false });
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.cwd, tmp);
    assert.match(result.commands.bash, new RegExp(SESSION_ID));
    assert.match(result.commands.powershell, /Set-Location/);
    assert.equal(sessions.get(SESSION_ID), undefined, 'must no longer be owned');
    assert.equal(result.relaunch.ok, false);
    assert.match(result.relaunch.detail, /skipped/i);
  } finally {
    sessions.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
});
