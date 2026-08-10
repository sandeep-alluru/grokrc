/**
 * End-to-end over the real HTTP + WebSocket stack: pairing, token auth, and the
 * session list. Deliberately does NOT spawn a grok agent — that would cost
 * tokens and make the suite slow. Agent behaviour is covered by
 * `grokrc doctor` and tools/acp-probe.mjs against the real binary.
 */
import { strict as assert } from 'node:assert';
import { watch } from './helpers/ws.ts';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// AuthStore reads GROKRC_HOME at import time, so redirect it before importing.
const tmp = await mkdtemp(join(tmpdir(), 'grokrc-test-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { WebSocket } = await import('ws');

const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager();
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0, // ephemeral
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
});
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

function ws(): Promise<InstanceType<typeof WebSocket>> {
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((res, rej) => {
    sock.once('open', () => res(sock));
    sock.once('error', rej);
  });
}

test('health endpoint responds', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('PWA is served at the root', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /grokrc/);
});

test('static serving cannot escape the web root', async () => {
  // Path traversal must not reach the filesystem above web/.
  const res = await fetch(`${base}/../package.json`, { redirect: 'manual' });
  assert.notEqual(res.status, 200);
});

test('pairing rejects a wrong code', async () => {
  auth.beginPairing();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'WRONG1', deviceName: 'test' }),
  });
  assert.equal(res.status, 401);
});

test('pairing issues a token, and the code is single-use', async () => {
  const { code } = auth.beginPairing();

  const ok = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'test-phone' }),
  });
  assert.equal(ok.status, 200);
  const { token } = await ok.json();
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 64);

  // Replaying the same code must fail.
  const replay = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'attacker' }),
  });
  assert.equal(replay.status, 401);
});

test('plaintext tokens are never persisted', async () => {
  const { code } = auth.beginPairing();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'hashcheck' }),
  });
  const { token } = await res.json();
  const { readFile } = await import('node:fs/promises');
  const store = await readFile(join(tmp, 'devices.json'), 'utf8');
  assert.ok(!store.includes(token), 'device store must not contain the plaintext token');
});

test('socket rejects an invalid token and closes 4401', async () => {
  const sock = await ws();
  const frames = watch<any>(sock);
  sock.send(JSON.stringify({ t: 'hello', token: 'deadbeef' }));
  const msg = await frames.waitFor(() => true);
  assert.equal(msg.t, 'error');
  const code = await new Promise<number>((res) => sock.once('close', (c) => res(c)));
  assert.equal(code, 4401);
});

test('commands before hello are refused', async () => {
  const sock = await ws();
  const frames = watch<any>(sock);
  sock.send(JSON.stringify({ t: 'sessions' }));
  const msg = await frames.waitFor(() => true);
  assert.equal(msg.t, 'error');
  assert.match(msg.message, /unauthorized/);
  sock.close();
});

test('prompting a session that does not exist reports an error', async () => {
  // Previously swallowed by `.catch(() => {})`, so a prompt into a read-only
  // observed session vanished with no feedback at all.
  const { code } = auth.beginPairing();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'err-phone' }),
  });
  const { token } = await res.json();

  const sock = await ws();
  const frames = watch<any>(sock);
  sock.send(JSON.stringify({ t: 'hello', token }));
  await frames.forType('ready');

  sock.send(JSON.stringify({ t: 'prompt', sessionId: 'does-not-exist', text: 'hi' }));
  const msg = await frames.forType('error');
  assert.match(msg.message, /no such session/);
  sock.close();
});

test('a paired device gets ready then the session list', async () => {
  const { code } = auth.beginPairing();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'e2e' }),
  });
  const { token } = await res.json();

  const sock = await ws();
  const frames = watch<any>(sock);
  sock.send(JSON.stringify({ t: 'hello', token }));

  const ready = await frames.forType('ready');
  assert.equal(ready.device.name, 'e2e');

  // `sessions` is also BROADCAST on any list change, so it may already have
  // arrived, or may follow. Match on it rather than assuming it is next.
  const list = await frames.forType('sessions');
  assert.ok(Array.isArray(list.sessions));
  assert.ok(Array.isArray(list.sessions));
  sock.close();
});
