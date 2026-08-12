/**
 * A single live event must not be able to bury a phone.
 *
 * BACKLOG #9. `trimEvent` caps any string in an event at 4,000 characters, and
 * the crash fix for #22 wired it into `trimHistory` — so OPENING a long session
 * is safe. The live path was never wired: `sessions.on('event')` broadcast the
 * event object exactly as it arrived. Opening a session was capped; sitting in
 * one and watching a turn arrive was not.
 *
 * That is the worse half. The owner's crash happened while READING a session,
 * and a `tool_call_update` carrying a whole file is routine — the largest event
 * measured in a real session is 117 KB, and nothing stops one being far bigger.
 *
 * There is no agent here on purpose. The subject is the daemon's broadcast
 * path: a real SessionManager emits, a real WebSocket delivers, and the
 * assertion is on the bytes a real client receives.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { watch } from './helpers/ws.ts';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-livesize-'));
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
  port: 0,
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

/** A paired client already watching `sessionId`. */
async function watcher(sessionId: string) {
  const { code } = auth.beginPairing();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'size-probe' }),
  });
  const { token } = (await res.json()) as { token: string };

  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r, j) => {
    sock.once('open', r);
    sock.once('error', j);
  });
  const frames = watch<any>(sock);
  sock.send(JSON.stringify({ t: 'hello', token }));
  await frames.forType('ready');
  sock.send(JSON.stringify({ t: 'open', sessionId }));
  await frames.forType('history');
  return { sock, frames };
}

const HUGE = 200_000;

test('a live tool event carrying a huge payload does not ship the body', async () => {
  // Stronger than a 4KB cap: tool I/O is stripped entirely for clients. The
  // interactive TUI never paints bash dumps; neither does the phone.
  const sessionId = 'live-size-1';
  const { sock, frames } = await watcher(sessionId);

  sessions.emit('event', {
    k: 'tool',
    sessionId,
    toolId: 't1',
    name: 'bash',
    status: 'ok',
    title: 'run something',
    output: 'x'.repeat(HUGE),
    input: 'y'.repeat(HUGE),
  });

  const frame = await frames.waitFor((m) => m.t === 'event' && m.event?.toolId === 't1');
  assert.equal(frame.event.output, undefined, 'tool output must not cross the wire');
  assert.equal(frame.event.input, undefined, 'tool input must not cross the wire');
  assert.equal(frame.event.title, 'run something');
  assert.ok(JSON.stringify(frame.event).length < 500, 'tool frame must stay tiny');
  sock.close();
});

test('the cap still walks nested strings on non-tool events', async () => {
  // Tool bodies are stripped; huge agent text / error payloads still need the
  // character ceiling so a single frame cannot bury the phone.
  const sessionId = 'live-size-2';
  const { sock, frames } = await watcher(sessionId);

  sessions.emit('event', {
    k: 'error',
    sessionId,
    message: 'y'.repeat(HUGE),
    fatal: false,
  });

  const frame = await frames.waitFor((m) => m.t === 'event' && m.event?.k === 'error');
  const msg = frame.event.message as string;
  assert.ok(msg.length < HUGE, `error message not capped (${msg.length})`);
  assert.match(msg, /more characters not shown/);
  sock.close();
});

test('an ordinary event is delivered untouched', async () => {
  // The cap must not become a silent mangler of normal traffic. Without this,
  // "everything is trimmed to nothing" would also pass the tests above.
  const sessionId = 'live-size-3';
  const { sock, frames } = await watcher(sessionId);
  const text = 'a normal reply from the agent';

  sessions.emit('event', { k: 'text', sessionId, role: 'agent', text, final: true });

  const frame = await frames.waitFor((m) => m.t === 'event' && m.event?.k === 'text');
  assert.equal(frame.event.text, text, 'a small event must arrive byte-for-byte');
  sock.close();
});
