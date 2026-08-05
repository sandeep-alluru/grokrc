#!/usr/bin/env node
/**
 * Drive the RUNNING daemon the way a person does.
 *
 * Every other check in this repo boots its own daemon in-process. That proves
 * the code is correct; it says nothing about the thing actually serving your
 * phone. Twice now a fix was verified green while the owner's client was still
 * broken — once because the daemon had not been restarted, once because an
 * installed PWA was serving a cached bundle. Both were invisible to the suite.
 *
 * This talks to a real daemon over the network, in a real browser, and pairs
 * itself through the control socket so there is nothing to type.
 *
 *   npm run check:live
 *   npm run check:live -- --url https://box.tailnet.ts.net
 *
 * It creates ONE throwaway session and closes it afterwards. It never opens or
 * modifies a session it did not create.
 */
import { chromium } from 'playwright';
import { controlRequest } from '../src/daemon/control.ts';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const URL_BASE = (arg('--url', 'http://127.0.0.1:4319') ?? '').replace(/\/$/, '');
const HEADED = process.argv.includes('--headed');

let failures = 0;
const note = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log(`\n  live check against ${URL_BASE}\n`);

/* ─── the daemon has to be up, and it has to be THIS daemon ───────────────── */

let health;
try {
  health = await (await fetch(`${URL_BASE}/api/health`)).json();
} catch (err) {
  console.error(`  ✗ cannot reach ${URL_BASE} — ${err.message}`);
  console.error('    Is the daemon running?  systemctl --user status grokrc\n');
  process.exit(1);
}
note(health?.ok === true, 'daemon answers /api/health', `version ${health?.version}`);

const { assetVersion } = await (await fetch(`${URL_BASE}/api/version`)).json();
note(!!assetVersion && assetVersion !== 'unknown', 'daemon reports an asset version', assetVersion);

// Pair through the control socket: no code to read off a terminal, and it
// proves the socket works on the running daemon too.
let code;
try {
  ({ code } = await controlRequest('pair'));
  note(!!code, 'issued a pairing code over the control socket', code);
} catch (err) {
  note(false, 'issued a pairing code over the control socket', err.message);
  console.error('\n  (the control socket is local-only, so --url must be this machine)\n');
  process.exit(1);
}

/* ─── browser ─────────────────────────────────────────────────────────────── */

const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// Read the created session's id off the wire rather than adding a test-only
// hook to the app. The socket is already observable.
let createdSessionId = null;
page.on('websocket', (ws) => {
  ws.on('framereceived', (f) => {
    try {
      const m = JSON.parse(String(f.payload));
      if (m.t === 'created' && m.session?.id) createdSessionId = m.session.id;
    } catch {
      /* sealed or partial frame — not ours to read */
    }
  });
});

try {
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });

  const stamped = await page.evaluate(() =>
    document.querySelector('script[type=module]')?.getAttribute('src')
  );
  note(
    stamped === `/app.js?v=${assetVersion}`,
    'the served page loads the current bundle',
    stamped ?? 'no script tag'
  );

  await page.waitForSelector('#v-pair.on', { timeout: 20_000 });
  await page.fill('#code', code);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 20_000 });
  note(true, 'paired and reached the session list');

  const running = await page.evaluate(() => globalThis.__rcws?.readyState === 1);
  note(running, 'websocket is open');

  const staleBanner = await page.$('[data-stale]');
  note(!staleBanner, 'the client is not stale');

  // ─── a real turn ────────────────────────────────────────────────────────
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 20_000 });
  await page.waitForTimeout(500);
  note(!!createdSessionId, 'created a session', createdSessionId ?? 'id not seen on the wire');

  note(
    (await page.textContent('#send'))?.trim() === 'Send',
    'a fresh session is ready to type into'
  );

  const handback = await page.$('[data-handback]');
  note(!!handback, 'a session you own offers a way to hand it back');

  await page.fill('#input', 'Count slowly from 1 to 200, one per line, with a comment on each.');
  await page.click('#send');

  const becameStop = await page
    .waitForFunction(() => document.querySelector('#send')?.textContent?.trim() === 'Stop', null, {
      timeout: 60_000,
    })
    .then(() => true)
    .catch(() => false);
  note(becameStop, 'Send becomes Stop while the agent works');

  await page.waitForTimeout(2500);
  await page.click('#send');
  const backToSend = await page
    .waitForFunction(() => document.querySelector('#send')?.textContent?.trim() === 'Send', null, {
      timeout: 60_000,
    })
    .then(() => true)
    .catch(() => false);
  note(backToSend, 'Stop cancels the turn and restores Send');

  await page.fill('#input', 'ok, stop there');
  await page.click('#send');
  await page.waitForTimeout(2500);
  const echoed = await page.$$eval('.msg.user .bubble', (n) =>
    n.map((x) => x.textContent ?? '').join(' | ')
  );
  note(/ok, stop there/.test(echoed), 'a prompt can still be sent after cancelling');

  // ─── back out ───────────────────────────────────────────────────────────
  await page.click('#back');
  await page.waitForSelector('#v-list.on', { timeout: 20_000 });
  const rows = await page.$$eval('.session', (n) => n.length);
  note(rows > 0, 'the session list renders', `${rows} row(s)`);

  note(pageErrors.length === 0, 'no uncaught errors in the page', pageErrors.join('; '));
} finally {
  // Close only what this check created.
  if (createdSessionId) {
    await page
      .evaluate(
        (id) => globalThis.__rcws?.send(JSON.stringify({ t: 'close', sessionId: id })),
        createdSessionId
      )
      .catch(() => {});
    await page.waitForTimeout(500);
  }
  await browser.close();
}

console.log(failures ? `\n  ─── ${failures} PROBLEM(S) ───\n` : '\n  ─── ALL CLEAR ───\n');
process.exit(failures ? 1 : 0);
