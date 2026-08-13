/**
 * B3 residual — hand-back over the same WebSocket path the phone uses.
 *
 * Unit tests cover SessionManager.release(); this drives create → release on a
 * real RemoteControlServer + MockTransport, and asserts the frame the phone
 * must receive (platform commands, session freed).
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { watch } from './helpers/ws.ts';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-release-ws-'));
process.env.GROKRC_HOME = tmp;
process.env.GROK_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');
const { WebSocket } = await import('ws');

let n = 0;
const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: `rel-ws-${++n}` }),
});
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
  defaultCwd: tmp,
});
const { port } = await server.listen();

after(async () => {
  sessions.closeAll();
  await server.close();
  // Hand-back may have launched a short-lived process still holding the tmp cwd.
  try {
    await rm(tmp, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
  }
});

async function pairAndConnect() {
  const { code } = auth.beginPairing();
  const res = await fetch(`http://127.0.0.1:${port}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'release-ws' }),
  });
  const { token } = (await res.json()) as { token: string };
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r, j) => {
    sock.once('open', () => r());
    sock.once('error', j);
  });
  const frames = watch<any>(sock);
  sock.send(JSON.stringify({ t: 'hello', token }));
  await frames.forType('ready');
  return { sock, frames };
}

test('phone path: create session then release returns bash+powershell+term', async () => {
  const { sock, frames } = await pairAndConnect();
  sock.send(JSON.stringify({ t: 'create', cwd: tmp }));
  const created = await frames.forType('created');
  const sessionId = created.session.id as string;
  assert.ok(sessionId);
  assert.ok(sessions.get(sessionId), 'daemon must own the session before release');

  sock.send(JSON.stringify({ t: 'release', sessionId }));
  const released = await frames.waitFor((m) => m.t === 'released' || m.t === 'error');
  assert.equal(released.t, 'released', released.message ?? 'expected released');
  assert.equal(released.sessionId, sessionId);
  assert.ok(released.commands?.bash, 'bash resume command required');
  assert.ok(released.commands?.powershell, 'powershell resume command required');
  assert.match(released.commands.powershell, /Set-Location/);
  assert.match(released.commands.bash, /grok -r/);
  assert.match(released.commands.term, /grokrc term --session/);
  // Legacy field for older PWAs
  assert.ok(released.command, 'legacy command field still set');
  assert.equal(sessions.get(sessionId), undefined, 'session must not be owned after release');
  sock.close();
});

test('release of a non-owned session returns a clear error (not silent)', async () => {
  const { sock, frames } = await pairAndConnect();
  sock.send(JSON.stringify({ t: 'release', sessionId: '019fabcd-0000-7000-8000-00000000zzz' }));
  const err = await frames.waitFor((m) => m.t === 'error' || m.t === 'released');
  assert.equal(err.t, 'error', 'must not pretend release succeeded');
  assert.match(String(err.message), /not owned|hand back/i);
  sock.close();
});
