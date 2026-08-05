/**
 * A phone must not silently run yesterday's JavaScript.
 *
 * Observed: a fix was deployed and verified against the live daemon in a real
 * browser, while the owner's installed PWA kept serving a cached bundle. The
 * daemon was correct, the client was not, and nothing on either side could tell
 * the two apart — "is this a bug, or an old client?" cost a round trip to
 * answer, twice.
 *
 * `cache-control: no-cache` asks a browser to revalidate; an installed PWA is
 * free to serve a stale copy anyway. So the app's URL carries a hash of its own
 * contents: a changed file is a different URL, and there is nothing stale left
 * to serve. The running client reads that hash back out of `import.meta.url` and
 * reports it on connect, so the daemon can say plainly when a client is behind.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-assetver-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

const WEB = resolve(import.meta.dirname, '../web');
const APP = join(WEB, 'app.js');

const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: 'av-1' }),
});
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: WEB,
  sessions,
  auth,
  defaultCwd: tmp,
});
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;

let originalApp: string;

before(async () => {
  originalApp = await readFile(APP, 'utf8');
});

after(async () => {
  // This test rewrites a served source file; put it back no matter what.
  await writeFile(APP, originalApp);
  sessions.closeAll();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

test('index.html points at a content-stamped app URL', async () => {
  const html = await (await fetch(base)).text();
  const m = html.match(/src="\/app\.js\?v=([a-f0-9]+)"/);
  assert.ok(m, `index.html must stamp the app URL, got: ${html.match(/app\.js[^"]*/)?.[0]}`);

  const { assetVersion } = (await (await fetch(`${base}/api/version`)).json()) as {
    assetVersion: string;
  };
  assert.equal(m![1], assetVersion, 'the stamped hash must match /api/version');
  assert.notEqual(assetVersion, 'unknown');
});

test('the stamp changes when the app changes', async () => {
  const before = (await (await fetch(`${base}/api/version`)).json()) as { assetVersion: string };

  await writeFile(APP, originalApp + '\n// cache-busting probe\n');
  const after = (await (await fetch(`${base}/api/version`)).json()) as { assetVersion: string };

  assert.notEqual(
    after.assetVersion,
    before.assetVersion,
    'editing the app did not change its version — caches would never be busted'
  );

  await writeFile(APP, originalApp);
  const restored = (await (await fetch(`${base}/api/version`)).json()) as { assetVersion: string };
  assert.equal(restored.assetVersion, before.assetVersion, 'the hash must be content-derived');
});

test('a stamped URL is cacheable forever; a bare one is not', async () => {
  const { assetVersion } = (await (await fetch(`${base}/api/version`)).json()) as {
    assetVersion: string;
  };
  const stamped = await fetch(`${base}/app.js?v=${assetVersion}`);
  const bare = await fetch(`${base}/app.js`);

  assert.match(stamped.headers.get('cache-control') ?? '', /immutable/);
  assert.match(bare.headers.get('cache-control') ?? '', /no-cache/);
});

/** Connect, say hello with a given version, and return the ready frame. */
async function helloWith(assetVersion?: string): Promise<Record<string, unknown>> {
  const { WebSocket } = await import('ws');
  const { code } = auth.beginPairing();
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'asset-version-test' }),
  });
  const { token } = (await res.json()) as { token: string };

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', token, assetVersion }));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ready frame')), 10_000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.t !== 'ready') return;
      clearTimeout(timer);
      ws.close();
      resolve(msg);
    });
  });
}

test('an out-of-date client is told it is out of date', async () => {
  const ready = await helloWith('0000deadbeef');
  assert.equal(ready.stale, true, 'a client on an old bundle must be told');
  assert.ok(ready.assetVersion, 'ready must carry the current version so the client can show it');
  assert.notEqual(ready.assetVersion, '0000deadbeef');
});

test('a current client is not nagged', async () => {
  const { assetVersion } = (await (await fetch(`${base}/api/version`)).json()) as {
    assetVersion: string;
  };
  const ready = await helloWith(assetVersion);
  assert.equal(ready.stale, false, 'an up-to-date client must not be told to reload');
});

test('a client that reports no version is not treated as stale', async () => {
  // Older clients predate the field. Nagging them on every connect would be
  // noise, and there is nothing they can do about it.
  const ready = await helloWith(undefined);
  assert.equal(ready.stale, false);
});
