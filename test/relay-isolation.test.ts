/**
 * Relay tenant isolation.
 *
 * A relay exists to host MORE THAN ONE daemon — that is the point of a shared
 * forwarder. So a frame from one room must never be able to affect another.
 *
 * `#pendingHttp` is keyed by a global counter (`http-1`, `http-2`, …) and the
 * daemon message handler answers any id it is given, with no check that the
 * pending request belongs to the room that answered. Ids are sequential and so
 * trivially guessable.
 *
 * The payload at stake is `/api/pair` — a device token.
 *
 * Written before the fix (directive 07).
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { RelayServer } from '../src/relay/server.ts';

const WEB = resolve(import.meta.dirname, '../web');
const relay = new RelayServer({ webRoot: WEB });
const port = await relay.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await relay.close();
});

/** A fake daemon socket for a room. Returns the socket plus a frame log. */
async function attachDaemon(room: string, key: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?room=${room}&key=${key}`);
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      /* ignore */
    }
  });
  return { ws, frames };
}

test('two rooms can coexist', async () => {
  const a = await attachDaemon('room-a', 'key-a');
  const b = await attachDaemon('room-b', 'key-b');
  assert.equal(a.ws.readyState, 1);
  assert.equal(b.ws.readyState, 1);
  a.ws.close();
  b.ws.close();
});

test("a daemon cannot answer another room's tunnelled HTTP request", async () => {
  const victim = await attachDaemon('victim', 'vkey');
  const attacker = await attachDaemon('attacker', 'akey');

  // The victim's browser pairs through the relay. Its daemon deliberately does
  // NOT answer, so the request stays pending and guessable.
  const pairing = fetch(`${base}/api/pair?room=victim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'REALCODE', deviceName: 'victim-phone' }),
  }).then(async (r) => ({ status: r.status, body: await r.text() }));

  // Wait until the victim's daemon has actually been handed the request, so we
  // know the pending id exists.
  const deadline = Date.now() + 4000;
  while (!victim.frames.some((f) => f.t === 'http') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const tunnelled = victim.frames.find((f) => f.t === 'http');
  assert.ok(tunnelled, 'victim daemon should have received the tunnelled request');
  const pendingId = tunnelled!.c as string;

  // The attacker's daemon forges a reply for the victim's pending id.
  attacker.ws.send(
    JSON.stringify({
      c: pendingId,
      t: 'http-res',
      d: JSON.stringify({
        status: 200,
        body: JSON.stringify({ token: 'FORGED-TOKEN-FROM-OTHER-ROOM', deviceId: 'evil' }),
      }),
    })
  );

  const result = await Promise.race([
    pairing,
    new Promise<{ status: number; body: string }>((r) =>
      setTimeout(() => r({ status: 0, body: '__timeout__' }), 6000)
    ),
  ]);

  victim.ws.close();
  attacker.ws.close();

  assert.doesNotMatch(
    result.body,
    /FORGED-TOKEN-FROM-OTHER-ROOM/,
    'a daemon in another room answered this request — cross-tenant response injection'
  );
});
