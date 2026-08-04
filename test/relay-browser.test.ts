/**
 * The path that was previously impossible: a browser that has NO route to the
 * daemon, loading and pairing the app entirely through the relay.
 *
 * The daemon's own HTTP listener is deliberately never contacted here — the page
 * is fetched from the relay, `/api/pair` is tunnelled over the daemon's outbound
 * socket, and the WebSocket is routed by room. This is what "works on cellular
 * with no inbound port" actually has to mean.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-relaybrowser-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { RelayServer } = await import('../src/relay/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

const WEB = resolve(import.meta.dirname, '../web');
const ROOM = 'browserroom';
const KEY = 'browserkey';

const relay = new RelayServer({ webRoot: WEB });
const relayPort = await relay.listen(0, '127.0.0.1');

const mocks: InstanceType<typeof MockTransport>[] = [];
const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => {
    const m = new MockTransport({ sessionId: `relay-mock-${mocks.length + 1}` });
    mocks.push(m);
    return m;
  },
});

// The daemon listens on an ephemeral port the browser will never touch.
const daemon = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: WEB,
  sessions,
  auth,
  defaultCwd: '/tmp/demo',
});
await daemon.listen();
daemon.connectRelay({ url: `ws://127.0.0.1:${relayPort}`, room: ROOM, key: KEY });
await new Promise((r) => setTimeout(r, 400));

const relayBase = `http://127.0.0.1:${relayPort}`;
let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  sessions.closeAll();
  await daemon.close();
  await relay.close();
  await rm(tmp, { recursive: true, force: true });
});

test('the relay serves the PWA itself', async () => {
  const res = await fetch(`${relayBase}/client?room=${ROOM}&key=${KEY}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Pair this device/);
});

test('relay static serving cannot escape the web root', async () => {
  const res = await fetch(`${relayBase}/../package.json`, { redirect: 'manual' });
  assert.notEqual(res.status, 200);
});

test('an /api call for an unknown room is refused', async () => {
  const res = await fetch(`${relayBase}/api/health?room=nosuchroom`);
  assert.equal(res.status, 503);
});

test('/api/health tunnels to the daemon', async () => {
  const res = await fetch(`${relayBase}/api/health?room=${ROOM}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('a bad pairing code is rejected through the tunnel', async () => {
  auth.beginPairing();
  const res = await fetch(`${relayBase}/api/pair?room=${ROOM}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'NOPE12', deviceName: 'x' }),
  });
  assert.equal(res.status, 401);
});

test('a browser loads, pairs, and drives a turn entirely via the relay', async () => {
  const { code } = auth.beginPairing();

  await page.goto(`${relayBase}/client?room=${ROOM}&key=${KEY}`);
  await page.waitForSelector('#v-pair.on');

  await page.fill('#code', code);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 15_000 });

  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 15_000 });

  await page.fill('#input', 'Create hello.txt');
  await page.click('#send');

  await page.waitForSelector('.approval', { timeout: 20_000 });
  await page.click('.approval button.allow:not(.broad)');
  await page.waitForSelector('.approval.resolved', { timeout: 15_000 });

  // The scripted agent, behind the daemon, behind the relay, got the answer.
  const deadline = Date.now() + 5000;
  while (!mocks[0]?.permissionAnswers.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(mocks[0]?.permissionAnswers.at(-1)?.optionId, 'allow-once');
});

test('the relay session survives a page reload (room persisted)', async () => {
  // A PWA launched from the home screen opens at "/" with no query string.
  await page.goto(`${relayBase}/`);
  await page.waitForSelector('#v-list.on', { timeout: 15_000 });
  assert.equal(await page.isVisible('#v-pair'), false);
});
