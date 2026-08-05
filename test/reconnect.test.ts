/**
 * Connection-layer behaviour in the browser client.
 *
 * Written BEFORE the fixes, to establish whether these are real defects or just
 * things that look wrong when read (directive D1). Each case drives the real PWA
 * in Chromium against a real daemon, then disrupts the socket.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-reconnect-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

let n = 0;
const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: `rc-${++n}` }),
});
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
  // A directory that actually exists: cwd is validated before spawning.
  defaultCwd: tmp,
});
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await ctx.newPage();

  const { code } = auth.beginPairing();
  await page.goto(base);
  await page.fill('#code', code);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 20_000 });
});

after(async () => {
  await browser?.close();
  sessions.closeAll();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

/** Force a socket drop from inside the page, as a network blip would. */
async function dropSocket(): Promise<void> {
  await page.evaluate(() => {
    // Close with a non-4401 code so the client takes its reconnect path.
    const s = (globalThis as unknown as { __rcws?: WebSocket }).__rcws;
    // 1006 is reserved and browsers refuse to send it; 4000 is a valid app code
    // that is NOT 4401, so the client takes its reconnect path.
    s?.close(4000, 'simulated drop');
  });
}

test('a session can be opened', async () => {
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 20_000 });
  assert.equal(await page.isVisible('#composer'), true);
});

test('the client survives a socket drop and stays in the session', async () => {
  // The bug under test: on reconnect the client handles `ready` by calling
  // show(vList), which throws you out of the session you were reading —
  // mid-turn, with no way to know why.
  const before = (await page.textContent('#title'))?.trim();

  await dropSocket();

  // Waiting on the `live` indicator alone is NOT enough: setConn('live') fires
  // on socket OPEN, before the `ready` frame is handled. An earlier version of
  // this test did exactly that and passed against the buggy code, because it
  // sampled the view before `ready` could switch it. Wait for the socket to be
  // genuinely OPEN *and* for a full round trip to have been processed.
  await page.waitForFunction(
    () => {
      const ws = (globalThis as unknown as { __rcws?: WebSocket }).__rcws;
      return ws?.readyState === 1;
    },
    undefined,
    { timeout: 20_000 }
  );
  // Give the ready/sessions handling a beat to run to completion.
  await page.waitForTimeout(1500);

  const sessionStillOpen = await page.evaluate(
    () => document.getElementById('v-session')?.classList.contains('on') ?? false
  );
  const after = (await page.textContent('#title'))?.trim();

  assert.equal(
    sessionStillOpen,
    true,
    `reconnect kicked the user back to the session list (title was "${before}", now "${after}")`
  );
});

test('a prompt sent while disconnected is reported, not silently dropped', async () => {
  // sendMsg() returns early when readyState !== 1, so the message vanishes with
  // no feedback — the same failure mode as the swallowed prompt rejection.
  await page.evaluate(() => {
    const s = (globalThis as unknown as { __rcws?: WebSocket }).__rcws;
    s?.close(4000, 'drop before send');
  });

  await page.fill('#input', 'this must not vanish');
  await page.click('#send');

  const surfaced = await page
    .waitForFunction(
      () => {
        const t = document.getElementById('v-session')?.textContent ?? '';
        return /reconnect|not connected|disconnected|queued/i.test(t);
      },
      undefined,
      { timeout: 8000 }
    )
    .then(() => true)
    .catch(() => false);

  assert.equal(surfaced, true, 'a prompt sent while offline disappeared with no message');
});
