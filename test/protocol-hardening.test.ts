/**
 * Client-protocol hardening.
 *
 * Every field here arrives from a remote device. These assert the daemon
 * rejects malformed shapes rather than coercing them into Map lookups, path
 * building, and process spawns — and that resource ceilings actually hold.
 *
 * Each case corresponds to a hole found by reading the code, not by a crash:
 *   - `create` never validated cwd, though `resume` did (so a paired client
 *     could spawn an agent in any directory)
 *   - nothing bounded the number of live agents
 *   - field types were trusted throughout
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-proto-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');
const { WebSocket } = await import('ws');

const auth = new AuthStore();
await auth.load();

let created = 0;
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: `proto-${++created}` }),
});

const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
  defaultCwd: '/tmp',
});
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;

after(async () => {
  sessions.closeAll();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

async function connected(): Promise<InstanceType<typeof WebSocket>> {
  const { code } = auth.beginPairing();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'proto' }),
  });
  const { token } = await res.json();

  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => sock.once('open', r));
  sock.send(JSON.stringify({ t: 'hello', token }));
  await next(sock); // ready
  await next(sock); // sessions
  return sock;
}

function next(sock: InstanceType<typeof WebSocket>, timeoutMs = 5000): Promise<any> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('timed out')), timeoutMs);
    sock.once('message', (d) => {
      clearTimeout(timer);
      res(JSON.parse(d.toString()));
    });
  });
}

/* ─── shape validation ────────────────────────────────────────────────────── */

const MALFORMED: [string, unknown][] = [
  ['sessionId as a number', { t: 'prompt', sessionId: 42, text: 'hi' }],
  ['sessionId as an object', { t: 'prompt', sessionId: { evil: true }, text: 'hi' }],
  ['sessionId as an array', { t: 'open', sessionId: ['a'] }],
  ['missing sessionId', { t: 'prompt', text: 'hi' }],
  ['text as a number', { t: 'prompt', sessionId: 'x', text: 7 }],
  ['missing text', { t: 'prompt', sessionId: 'x' }],
  ['cwd as a number on resume', { t: 'resume', sessionId: 'x', cwd: 5 }],
  ['missing cwd on resume', { t: 'resume', sessionId: 'x' }],
  ['cwd as an object on create', { t: 'create', cwd: {} }],
  ['optionId as a number', { t: 'approve', sessionId: 'x', requestId: 'y', optionId: 3 }],
  ['unknown message type', { t: 'definitely-not-a-real-message' }],
];

for (const [label, payload] of MALFORMED) {
  test(`rejects ${label}`, async () => {
    const sock = await connected();
    sock.send(JSON.stringify(payload));
    const msg = await next(sock);
    assert.equal(msg.t, 'error', `expected an error for ${label}, got ${JSON.stringify(msg)}`);
    sock.close();
  });
}

test('accepts a null optionId — that legitimately cancels an approval', async () => {
  const sock = await connected();
  sock.send(JSON.stringify({ t: 'approve', sessionId: 'x', requestId: 'y', optionId: null }));
  const msg = await next(sock);
  // Rejected for being unknown, NOT for its shape.
  assert.equal(msg.t, 'error');
  assert.doesNotMatch(msg.message, /must be a string/);
  sock.close();
});

/* ─── spawn directory ─────────────────────────────────────────────────────── */

test('create refuses a relative cwd', async () => {
  await assert.rejects(() => sessions.create('not/absolute'), /absolute/i);
});

test('create refuses a non-string cwd', async () => {
  await assert.rejects(() => sessions.create(undefined as unknown as string), /absolute/i);
});

/* ─── resource ceilings ───────────────────────────────────────────────────── */

test('live sessions are capped', async () => {
  // A client looping on `create` must not be able to fork agents without limit.
  const made: string[] = [];
  let capped = false;
  for (let i = 0; i < 20; i++) {
    try {
      made.push((await sessions.create('/tmp')).id);
    } catch (err) {
      assert.match((err as Error).message, /too many live sessions/);
      capped = true;
      break;
    }
  }
  assert.ok(capped, `expected a cap, created ${made.length} sessions unchecked`);
  for (const id of made) sessions.close(id);
});
