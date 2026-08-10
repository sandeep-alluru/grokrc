/**
 * Full relay round-trip: daemon dials OUT, phone dials IN, and a real pairing +
 * session-list exchange completes through the forwarder.
 *
 * The property that matters most here is that relayed clients are NOT trusted
 * more than direct ones — arriving via the relay must not bypass token auth.
 */
import { strict as assert } from 'node:assert';
import { watch } from './helpers/ws.ts';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-relay-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { RelayServer } = await import('../src/relay/server.ts');
const { WebSocket } = await import('ws');

const relay = new RelayServer();
const relayPort = await relay.listen(0, '127.0.0.1');

const auth = new AuthStore();
await auth.load();
// The subject here is the RELAY — routing, isolation, tunnelled HTTP. The agent
// is a dependency, not the thing under test, so it is scripted: that makes these
// runnable on a machine with no grok installed, which is where they were timing
// out on every CI run.
let relayMock = 0;
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: `relay-${++relayMock}` }),
});
const daemon = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
});
const bound = await daemon.listen();

const ROOM = 'testroom';
const KEY = 'testkey123';
daemon.connectRelay({ url: `ws://127.0.0.1:${relayPort}`, room: ROOM, key: KEY });

after(async () => {
  await daemon.close();
  await relay.close();
  await rm(tmp, { recursive: true, force: true });
});

function clientUrl(key = KEY) {
  return `ws://127.0.0.1:${relayPort}/client?room=${ROOM}&key=${key}`;
}

/**
 * Open a relayed socket and start buffering its frames in the same breath.
 *
 * The watcher has to exist before anything is sent: a reply that arrives first
 * is dropped by the EventEmitter, not queued, which is how these timed out with
 * `frames seen: []` on a machine with no agent installed.
 */
function connect(
  url: string
): Promise<{ sock: InstanceType<typeof WebSocket>; frames: ReturnType<typeof watch<any>> }> {
  const sock = new WebSocket(url);
  return new Promise((res, rej) => {
    sock.once('open', () => res({ sock, frames: watch<any>(sock) }));
    sock.once('error', rej);
    sock.once('close', (c: number) => rej(new Error('closed ' + c)));
  });
}

// Give the daemon's outbound dial a moment to land before clients connect.
await new Promise((r) => setTimeout(r, 300));

test('relay is alive', async () => {
  // `/` now serves the PWA, so health moved to /health.
  const res = await fetch(`http://127.0.0.1:${relayPort}/health`);
  assert.equal((await res.json()).service, 'grokrc-relay');
});

test('relay serves the app at /', async () => {
  const res = await fetch(`http://127.0.0.1:${relayPort}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
});

test('a wrong room key is refused at the relay', async () => {
  await assert.rejects(() => connect(clientUrl('wrongkey')));
});

test('a relayed client still needs a valid token', async () => {
  // The relay must not be a trust boundary — auth happens at the daemon.
  const { sock, frames } = await connect(clientUrl());
  sock.send(JSON.stringify({ t: 'hello', token: 'not-a-real-token' }));
  const msg = await frames.waitFor(() => true);
  assert.equal(msg.t, 'error');
  assert.match(msg.message, /unauthorized/);
  sock.close();
});

test('a paired device completes a full exchange through the relay', async () => {
  // Pair over the daemon's own HTTP listener, then use the token via the relay.
  const { code } = auth.beginPairing();
  const res = await fetch(`http://127.0.0.1:${bound.port}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'relay-phone' }),
  });
  const { token } = await res.json();

  const { sock, frames } = await connect(clientUrl());
  sock.send(JSON.stringify({ t: 'hello', token }));

  const ready = await frames.forType('ready');
  assert.equal(ready.t, 'ready');
  assert.equal(ready.device.name, 'relay-phone');

  const list = await frames.forType('sessions');
  assert.equal(list.t, 'sessions');
  assert.ok(Array.isArray(list.sessions));
  sock.close();
});

test('two relayed clients are isolated from each other', async () => {
  const { code } = auth.beginPairing();
  const res = await fetch(`http://127.0.0.1:${bound.port}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'phone-b' }),
  });
  const { token } = await res.json();

  const { sock: a } = await connect(clientUrl());
  const { sock: b, frames: bFrames } = await connect(clientUrl());

  // Only b authenticates; a must not receive b's frames.
  const aSaw: unknown[] = [];
  a.on('message', (d) => aSaw.push(JSON.parse(d.toString())));

  b.send(JSON.stringify({ t: 'hello', token }));
  const ready = await bFrames.forType('ready');
  assert.equal(ready.t, 'ready');

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(aSaw.length, 0, 'client A received frames addressed to client B');

  a.close();
  b.close();
});
