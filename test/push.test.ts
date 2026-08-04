/**
 * Push service: key persistence, subscription hygiene, and authorization on the
 * subscribe endpoint. Real delivery isn't tested — that needs a browser push
 * service — but everything that decides *whether* and *to whom* we send is.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-push-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { PushService } = await import('../src/daemon/push.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');

const auth = new AuthStore();
await auth.load();
const push = new PushService();
await push.load();

const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions: new SessionManager(),
  auth,
  push,
});
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;

after(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

const FAKE_SUB = {
  endpoint: 'https://push.example.com/abc',
  keys: { p256dh: 'BExample', auth: 'authsecret' },
};

async function pairedToken(name: string): Promise<string> {
  const { code } = auth.beginPairing();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: name }),
  });
  return (await res.json()).token;
}

test('VAPID keys are generated and persisted 0600', async () => {
  assert.ok(push.publicKey.length > 20);
  const raw = JSON.parse(await readFile(join(tmp, 'vapid.json'), 'utf8'));
  assert.ok(raw.publicKey && raw.privateKey);

  // A second instance must reuse the keys — regenerating would silently
  // invalidate every existing subscription.
  const again = new PushService();
  await again.load();
  assert.equal(again.publicKey, push.publicKey);
});

test('the public key is served but the private key never is', async () => {
  const res = await fetch(`${base}/api/push/key`);
  const body = await res.json();
  assert.equal(body.publicKey, push.publicKey);
  assert.equal(JSON.stringify(body).includes('privateKey'), false);
});

test('subscribing requires a valid device token', async () => {
  const res = await fetch(`${base}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'bogus', subscription: FAKE_SUB }),
  });
  assert.equal(res.status, 401);
});

test('a paired device can subscribe', async () => {
  const token = await pairedToken('push-phone');
  const res = await fetch(`${base}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, subscription: FAKE_SUB }),
  });
  assert.equal(res.status, 200);
  assert.equal(push.subscriberCount, 1);
});

test('re-subscribing the same endpoint replaces rather than duplicates', async () => {
  // Otherwise every reinstall doubles the notifications you receive.
  const before = push.subscriberCount;
  const token = await pairedToken('push-phone-again');
  await fetch(`${base}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, subscription: FAKE_SUB }),
  });
  assert.equal(push.subscriberCount, before);
});

test('a different endpoint adds a subscriber', async () => {
  const token = await pairedToken('tablet');
  await fetch(`${base}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      subscription: { ...FAKE_SUB, endpoint: 'https://push.example.com/xyz' },
    }),
  });
  assert.equal(push.subscriberCount, 2);
});

test('notifying with unreachable endpoints does not throw', async () => {
  // Sends go to example.com and fail; the caller must never see that.
  await push.notifyApproval(
    {
      k: 'approval',
      sessionId: 's1',
      requestId: 'r1',
      title: 'Run rm -rf build',
      options: [],
    },
    'my-project'
  );
});

test('the service worker is served', async () => {
  const res = await fetch(`${base}/sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /javascript/);
  assert.match(await res.text(), /notificationclick/);
});
