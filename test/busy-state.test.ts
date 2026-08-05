/**
 * "Stop" must mean a turn is running NOW, not that one was running once.
 *
 * Reported after taking over a terminal session from a phone: the composer
 * showed **Stop** and no message could be sent. Tapping it sent a cancel rather
 * than a prompt, so the session was unusable.
 *
 * Cause: `applyEvent(ev, replaying)` takes a flag saying "this is history being
 * replayed", uses it at the bottom to skip scrolling — and ignores it in the
 * `status` case. So a replayed `status: working` set `state.busy = true`.
 *
 * That is fine while a turn really is running, because the matching terminal
 * status follows. It is not fine when the agent died mid-turn: the `working`
 * event is in the log forever and the `done` never arrived. Taking over a
 * session kills the terminal's grok, which is exactly how a turn ends without a
 * terminal status — so the feature built yesterday reliably produces the log
 * shape that jams the composer.
 *
 * History cannot answer "is something running right now". Only the live stream
 * and the session's own state can.
 *
 * Written before the fix (directive 07). PRE-FIX the first assert fails.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-busy-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

let n = 0;
const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: `busy-${++n}` }),
});
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
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
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 20_000 });
});

after(async () => {
  await browser?.close();
  sessions.closeAll();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Push a frame through the real socket handler.
 *
 * The app registers `addEventListener('message')` on the WebSocket, so a
 * synthetic MessageEvent runs the genuine code path — no test-only hook, and no
 * need to make an agent die on cue.
 */
async function deliver(frame: unknown): Promise<void> {
  await page.evaluate((raw) => {
    const ws = (globalThis as unknown as { __rcws?: WebSocket }).__rcws;
    ws?.dispatchEvent(new MessageEvent('message', { data: raw }));
  }, JSON.stringify(frame));
  await page.waitForTimeout(250);
}

const sendLabel = () => page.textContent('#send');

test('replayed history that ends mid-turn does not jam the composer', async () => {
  assert.equal((await sendLabel())?.trim(), 'Send', 'precondition: idle session shows Send');

  const sessionId = await page.evaluate(
    () => (document.querySelector('[data-handback]') ? '' : '') || 'busy-1'
  );

  // The log an agent leaves when it is killed mid-turn: a `working` status and
  // no terminal status after it.
  await deliver({
    t: 'history',
    sessionId,
    events: [
      { k: 'message', sessionId, role: 'user', text: 'do a thing' },
      { k: 'status', sessionId, state: 'working' },
    ],
  });

  assert.equal(
    (await sendLabel())?.trim(),
    'Send',
    'the composer is stuck on Stop after replaying an interrupted turn — no message can be sent'
  );
  assert.equal(
    await page.$eval('#send', (b) => (b as HTMLButtonElement).classList.contains('stop')),
    false,
    'send button still styled as Stop'
  );
});

test('a LIVE working status still shows Stop', async () => {
  // Guard against over-correcting: suppressing the replayed status must not
  // suppress the real one, or a running turn becomes uncancellable.
  await deliver({
    t: 'event',
    event: { k: 'status', sessionId: 'busy-1', state: 'working' },
  });
  assert.equal((await sendLabel())?.trim(), 'Stop', 'a live working status must show Stop');

  await deliver({
    t: 'event',
    event: { k: 'status', sessionId: 'busy-1', state: 'idle' },
  });
  assert.equal((await sendLabel())?.trim(), 'Send', 'a live idle status must restore Send');
});

test('typing and sending works after an interrupted-turn replay', async () => {
  // The property the user actually cares about: the box accepts a message.
  await deliver({
    t: 'history',
    sessionId: 'busy-1',
    events: [{ k: 'status', sessionId: 'busy-1', state: 'working' }],
  });

  await page.fill('#input', 'hello after takeover');
  await page.click('#send');
  await page.waitForTimeout(400);

  const echoed = await page.$$eval('.msg.user .bubble', (b) =>
    b.map((x) => x.textContent ?? '').join('|')
  );
  assert.match(
    echoed,
    /hello after takeover/,
    'the prompt was never sent — the button was still a Stop button'
  );
});
