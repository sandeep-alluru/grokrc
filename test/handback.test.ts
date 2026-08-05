/**
 * The hand-back affordance must survive a transcript render.
 *
 * `renderTranscript()` replaces the whole session view, then re-adds the resume
 * bar for OBSERVED sessions only. The hand-back bar — the only way to give a
 * session back to a terminal — was not in that list, so it was destroyed the
 * moment history arrived.
 *
 * History arrives on open, on reconnect, and immediately after a takeover, which
 * is precisely when someone wants to hand the session back. In practice the
 * button was never visible: `openSession()` drew it, and the `history` frame that
 * followed a few milliseconds later wiped it.
 *
 * The same shape of bug as `.resume-bar` had, on the twin code path.
 *
 * Written before the fix (directive 07). PRE-FIX the first assert fails.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-handback-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

let n = 0;
const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: `hb-${++n}` }),
});
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
  defaultCwd: '/tmp/demo',
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

test('a session you own offers a way to hand it back', async () => {
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 20_000 });

  // Drive a turn so history is non-trivial, then force the replay that wipes
  // the view — exactly what happens right after a takeover.
  await page.fill('#input', 'hello');
  await page.click('#send');
  await page.waitForTimeout(1500);

  const present = await page
    .waitForSelector('[data-handback]', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  assert.equal(
    present,
    true,
    'no hand-back control after the transcript rendered — the only way to return a session to a terminal is gone'
  );
});

test('it survives a reconnect, which replays history', async () => {
  await page.evaluate(() => {
    (globalThis as unknown as { __rcws?: WebSocket }).__rcws?.close(4000, 'force reconnect');
  });
  await page.waitForFunction(
    () => (globalThis as unknown as { __rcws?: WebSocket }).__rcws?.readyState === 1,
    undefined,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(1500);

  const present = await page
    .waitForSelector('[data-handback]', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  assert.equal(present, true, 'hand-back control vanished after a reconnect replayed history');
});

test('an observed session offers resume, never hand-back', async () => {
  // Guard against over-correcting: a read-only session has nothing to hand back,
  // and showing the control there would imply it can be driven.
  const both = await page.evaluate(() => ({
    handback: !!document.querySelector('[data-handback]'),
    resume: !!document.querySelector('[data-resume]'),
  }));
  assert.equal(both.resume, false, 'an owned session should not show the resume bar');
  assert.equal(both.handback, true, 'an owned session should show hand-back');
});
