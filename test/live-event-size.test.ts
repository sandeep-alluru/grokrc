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

test('a live tool event carrying a huge payload is capped before it is sent', async () => {
  const sessionId = 'live-size-1';
  const { sock, frames } = await watcher(sessionId);

  sessions.emit('event', {
    k: 'tool',
    sessionId,
    toolId: 't1',
    name: 'bash',
    status: 'completed',
    output: 'x'.repeat(HUGE),
  });

  const frame = await frames.waitFor((m) => m.t === 'event' && m.event?.toolId === 't1');
  const out = frame.event.output as string;

  assert.ok(
    out.length < HUGE,
    `the daemon forwarded ${out.length} characters unchanged — a live event is not trimmed`
  );
  assert.match(out, /more characters not shown/, 'a trimmed event must say what was cut');
  sock.close();
});

test('the cap reaches nested payloads, not just the top level', async () => {
  // The bulk of a real tool result is nested — content[].newText, rawOutput,
  // _meta.details. An earlier version of the history trim walked only `.text`
  // and changed the measured payload by exactly nothing.
  const sessionId = 'live-size-2';
  const { sock, frames } = await watcher(sessionId);

  sessions.emit('event', {
    k: 'tool',
    sessionId,
    toolId: 't2',
    name: 'edit',
    status: 'completed',
    output: { content: [{ newText: 'y'.repeat(HUGE) }], _meta: { details: 'z'.repeat(HUGE) } },
  });

  const frame = await frames.waitFor((m) => m.t === 'event' && m.event?.toolId === 't2');
  const whole = JSON.stringify(frame.event);
  assert.ok(
    whole.length < HUGE,
    `nested payload survived at ${whole.length} characters — the walk is not reaching it`
  );
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
