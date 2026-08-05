/**
 * Client state that survives a transcript re-render.
 *
 * `renderTranscript()` calls `el.vSession.replaceChildren()` and then clears the
 * node caches — toolNodes, approvalNodes, streaming, planNode. It does NOT clear
 * `thinkingNode`. That reference now points at a DETACHED element, so every
 * subsequent thinking chunk is appended to a node that is not in the document
 * and the user sees no reasoning at all.
 *
 * History is replayed on reconnect, on resume, and on opening a session — so
 * this is the common path, not an edge case.
 *
 * Written before the fix (directive 07).
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-clientstate-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

let n = 0;
const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: `cs-${++n}` }),
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

test('thinking still renders after a transcript re-render', async () => {
  // Turn 1 — establishes a thinkingNode.
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 20_000 });
  await page.fill('#input', 'first turn');
  await page.click('#send');
  await page.waitForSelector('.thinking', { timeout: 20_000 });

  const firstCount = await page.$$eval('.thinking', (nodes) => nodes.length);
  assert.ok(firstCount > 0, 'thinking should render on the first turn');

  // Force the exact re-render that history replay performs.
  await page.evaluate(() => {
    (globalThis as unknown as { __rcws?: WebSocket }).__rcws?.close(4000, 'force reconnect');
  });
  await page.waitForFunction(
    () => (globalThis as unknown as { __rcws?: WebSocket }).__rcws?.readyState === 1,
    undefined,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(1200);

  // Turn 2 — the stale thinkingNode would swallow this entirely.
  await page.fill('#input', 'second turn');
  await page.click('#send');

  const visible = await page
    .waitForFunction(
      () => {
        const nodes = [...document.querySelectorAll('.thinking')];
        // Attached to the document AND carrying text.
        return nodes.some(
          (x) => document.body.contains(x) && (x.textContent ?? '').trim().length > 0
        );
      },
      undefined,
      { timeout: 25_000 }
    )
    .then(() => true)
    .catch(() => false);

  assert.equal(
    visible,
    true,
    'thinking vanished after the transcript was re-rendered — appended to a detached node'
  );
});
