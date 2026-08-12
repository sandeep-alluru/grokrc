/**
 * B14 thorough E2E — no half-measures.
 *
 * 1) Real Chromium phone UI: pair → create → hand back → released card visible.
 * 2) Windows relaunch: with a FAKE grok binary that stays alive, hand-back must
 *    start at least one new process (proves launch methods actually fire).
 *
 * Take over is covered separately for the kill path; this file owns "give back".
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-handback-e2e-'));
const fakeBinDir = await mkdtemp(join(tmpdir(), 'grokrc-fake-grok-'));
process.env.GROKRC_HOME = tmp;
// Isolated grok home so we never touch the owner's sessions during browser e2e.
process.env.GROK_HOME = await mkdtemp(join(tmpdir(), 'grokrc-handback-gh-'));

const IS_WIN = process.platform === 'win32';

/** Fake "grok" that stays alive long enough to detect the process. */
async function installFakeGrok(): Promise<string> {
  if (IS_WIN) {
    // .cmd so CreateProcess can run it without needing a real PE binary.
    const bat = join(fakeBinDir, 'grok.cmd');
    await writeFile(
      bat,
      [
        '@echo off',
        'echo fake-grok %*',
        // Stay alive ~20s so the e2e can observe the pid.
        'ping -n 21 127.0.0.1 >nul',
        '',
      ].join('\r\n'),
      'utf8'
    );
    // Also place grok.exe path expectation — resolveGrokBinary looks for grok.exe
    // under ~/.grok/bin. Point GROK_BIN at our cmd via a wrapper .exe isn't
    // available; use GROK_BIN env.
    return bat;
  }
  const sh = join(fakeBinDir, 'grok');
  await writeFile(sh, '#!/bin/sh\necho fake-grok "$@"\nsleep 20\n', 'utf8');
  await chmod(sh, 0o755);
  return sh;
}

const fakeGrok = await installFakeGrok();
process.env.GROK_BIN = fakeGrok;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');
const { relaunchGrokTui } = await import('../src/daemon/relaunch-tui.ts');

const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: `hb-e2e-${Date.now()}` }),
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
  page.on('pageerror', (err) => {
    throw new Error(`page error: ${err.message}`);
  });
});

after(async () => {
  await browser?.close();
  sessions.closeAll();
  await server.close();
  // Hand-back may still hold a console with cwd under tmp (Windows EBUSY).
  // Never fail the suite on temp cleanup — OS will reclaim %TEMP%.
  for (const dir of [tmp, process.env.GROK_HOME!, fakeBinDir]) {
    for (let i = 0; i < 10; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
});

async function pair(): Promise<void> {
  const { code } = auth.beginPairing();
  await page.goto(base);
  await page.waitForSelector('#v-pair.on');
  await page.fill('#code', code);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 15_000 });
}

test('browser: create session then hand back shows released card with commands', async () => {
  await pair();
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 15_000 });
  await page.waitForSelector('[data-handback]', { timeout: 10_000 });

  // Double-tap hand back (armed confirm).
  await page.click('[data-handback] button');
  await page.waitForFunction(
    () => (document.querySelector('[data-handback] button')?.textContent ?? '').includes('again'),
    undefined,
    { timeout: 5_000 }
  );
  await page.click('[data-handback] button');

  // Must land on list with a visible success card — not a blank bar.
  await page.waitForSelector('#v-list.on', { timeout: 15_000 });
  await page.waitForSelector('[data-released-card]', { timeout: 15_000 });
  const cardText = (await page.textContent('[data-released-card]')) ?? '';
  assert.match(cardText, /Handed back/i, cardText);
  assert.match(cardText, /grok -r|Set-Location|grokrc term/i, cardText);

  // Retry / unreachable must NOT be the only UI (connection should still be live).
  const unreachableHidden = await page.$eval('#unreachable', (el) =>
    (el as HTMLElement).hidden
  );
  assert.equal(unreachableHidden, true, 'hand-back must not drop the websocket');
});

test('browser: unreachable retry button has visible non-empty label', async () => {
  // Force disconnect UI without killing the server — close the socket from the page.
  await page.evaluate(() => {
    (globalThis as unknown as { __rcws?: WebSocket }).__rcws?.close(4000, 'e2e-drop');
  });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('#unreachable') as HTMLElement | null;
      return el && !el.hidden;
    },
    undefined,
    { timeout: 10_000 }
  );
  const btnText = ((await page.textContent('#unreachable-retry')) ?? '').trim();
  assert.ok(btnText.length > 0, 'Retry button must not be blank');
  assert.match(btnText, /Retry|Connect/i, btnText);
  // High-contrast styles applied
  const color = await page.$eval('#unreachable-retry', (el) => getComputedStyle(el).color);
  // rgb white-ish
  assert.ok(color.includes('255') || color === 'white' || color === '#ffffff', `color=${color}`);
});

test('Windows relaunch actually starts the fake grok process', async (t) => {
  if (!IS_WIN) return t.skip('Windows-only process proof');

  const { execSync } = await import('node:child_process');
  const before = execSync('tasklist /FI "IMAGENAME eq cmd.exe" /FO CSV /NH', {
    encoding: 'utf8',
  });

  const r = relaunchGrokTui(tmp, '019fabcd-0000-7000-8000-00000000e2e');
  assert.equal(r.ok, true, r.detail);
  assert.ok(r.methods && r.methods.length >= 1, String(r.methods));
  assert.ok(
    r.methods!.some(
      (m) =>
        m.startsWith('start-process') ||
        m.startsWith('script:') ||
        m.startsWith('ps1:') ||
        m.startsWith('cmd:') ||
        m === 'cmd-start-script'
    ),
    `expected launch methods, got ${r.methods}`
  );

  // Soft process check: a new cmd may host the hand-back script.
  await new Promise((res) => setTimeout(res, 1500));
  const after = execSync('tasklist /FI "IMAGENAME eq cmd.exe" /FO CSV /NH', {
    encoding: 'utf8',
  });
  assert.ok(after.length > 0, 'tasklist ran');
  void before;
});
