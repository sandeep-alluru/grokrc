/**
 * The push prompt must never render nothing.
 *
 * iOS exposes `PushManager` ONLY in a home-screen (standalone) app — in a plain
 * Safari tab it is absent. `renderPushPrompt()` guarded on that and returned
 * early, so on the one platform where push needs an extra step the UI showed no
 * row, no reason, and no way forward. The user is left staring at a session list
 * wondering where the button went.
 *
 * A missing capability is information the user needs, not a reason to go quiet.
 *
 * Written before the fix (directive 07). PRE-FIX this fails on the first assert.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-pushprompt-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

let n = 0;
const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: `pp-${++n}` }),
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

before(async () => {
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  sessions.closeAll();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

/**
 * A page that looks like an iOS Safari TAB: no PushManager, no Notification.
 * This is the exact shape that made the row vanish on the owner's iPhone.
 */
async function safariTabPage(): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    // @ts-expect-error — deliberately removing a platform API
    delete window.PushManager;
    // @ts-expect-error — iOS Safari tabs have no Notification either
    delete window.Notification;
  });
  const page = await ctx.newPage();
  const { code } = auth.beginPairing();
  await page.goto(base);
  await page.fill('#code', code);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 20_000 });
  return { ctx, page };
}

test('a browser without PushManager still gets a row explaining why', async () => {
  const { ctx, page } = await safariTabPage();
  try {
    // The session list rendered at all — proves the missing APIs did not throw
    // and kill renderList partway through.
    await page.waitForSelector('#v-list button.btn-primary', { timeout: 20_000 });

    const row = await page.$('[data-push-prompt]');
    assert.ok(row, 'no push row rendered — a browser that cannot do push is told nothing at all');

    const text = ((await row!.textContent()) ?? '').toLowerCase();
    assert.match(
      text,
      /home screen|home-screen/,
      `the row must name the fix (open from the home screen), got: ${text}`
    );

    // `.session` must mean a real session and nothing else. When this row wore
    // that class it sat above the list, so `click('.session')` opened a
    // notification prompt instead of a session — silently, in the real-stack
    // resume check.
    assert.equal(
      await row!.evaluate((n: Element) => n.classList.contains('session')),
      false,
      'the push row must not carry the .session class — it is not a session'
    );
    // resume-check does `page.click('.session')`. Whatever that selector hits
    // first must be a real session, never this row.
    assert.equal(
      await page.$$eval('.session', (n) => n[0]?.hasAttribute('data-push-prompt') ?? false),
      false,
      'the first .session on the page is the push row — clicks meant for a session land here'
    );
  } finally {
    await ctx.close();
  }
});

test('a browser that supports push offers a tappable enable row', async () => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: [], // permission stays "default" — the state that needs a gesture
  });
  const page = await ctx.newPage();
  try {
    const { code } = auth.beginPairing();
    await page.goto(base);
    await page.fill('#code', code);
    await page.click('#pair-go');
    await page.waitForSelector('#v-list.on', { timeout: 20_000 });
    await page.waitForSelector('#v-list button.btn-primary', { timeout: 20_000 });

    const row = await page.$('[data-push-prompt]');
    assert.ok(row, 'push-capable browser should still be offered the enable row');
    const text = ((await row!.textContent()) ?? '').toLowerCase();
    assert.match(text, /enable notifications/, `expected an enable affordance, got: ${text}`);
  } finally {
    await ctx.close();
  }
});
