#!/usr/bin/env node
/**
 * Full end-to-end over the real HTTPS origin, through `tailscale serve`.
 *
 * The app is the same either way, but the transport is not. Over HTTPS the
 * client speaks `wss://` and every frame crosses the Tailscale proxy — if that
 * proxy doesn't forward the WebSocket upgrade, the page loads perfectly and
 * then silently never connects. Nothing else in the suite exercises that path.
 *
 * Also checks the things only a secure context allows: service worker
 * registration and a real VAPID key fetch, which is what push depends on.
 *
 *   node tools/https-e2e-check.mjs <origin> <pairing-code>
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'docs/screenshots');
const ORIGIN = process.argv[2];
const CODE = process.argv[3];

if (!ORIGIN || !CODE) {
  console.error('usage: node tools/https-e2e-check.mjs <origin> <pairing-code>');
  process.exit(2);
}

const problems = [];
const note = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) problems.push(msg);
};

const browser = await chromium.launch();
// No ignoreHTTPSErrors — an untrusted cert must fail here, exactly as it would
// on a phone.
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['notifications'],
});
const page = await ctx.newPage();

const wsUrls = [];
page.on('websocket', (ws) => wsUrls.push(ws.url()));
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

try {
  await mkdir(SHOTS, { recursive: true });
  console.log(`origin: ${ORIGIN}\n`);

  const res = await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  note(res?.status() === 200, `loads over HTTPS (${res?.status()})`);
  note(await page.evaluate(() => globalThis.isSecureContext), 'secure context');

  /* pairing over TLS */
  await page.fill('#code', CODE);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 25_000 });
  note(true, 'paired over HTTPS');

  /* the actual question: does the WebSocket survive the proxy? */
  note(wsUrls.length > 0, `WebSocket opened (${wsUrls[0] ?? 'none'})`);
  note(
    wsUrls.some((u) => u.startsWith('wss://')),
    'WebSocket upgraded to wss:// through tailscale serve'
  );
  const live = await page.evaluate(() => document.getElementById('conn').className.includes('live'));
  note(live, 'connection indicator is live');

  /* a real turn, streamed over wss */
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 25_000 });
  await page.fill('#input', 'Reply with exactly: TLS-OK');
  await page.click('#send');

  const replied = await page
    .waitForFunction(
      () => [...document.querySelectorAll('.msg.agent .bubble')].some((b) => (b.textContent ?? '').trim()),
      undefined,
      { timeout: 180_000 }
    )
    .then(() => true)
    .catch(() => false);
  note(replied, 'agent response streamed back over wss://');

  await new Promise((r) => setTimeout(r, 2000));
  const reply = await page.$$eval('.msg.agent .bubble', (b) =>
    b.map((x) => (x.textContent ?? '').trim()).filter(Boolean)
  );
  note(reply.some((t) => /TLS-OK/i.test(t)), `agent said TLS-OK (got: "${reply[0]?.slice(0, 60)}")`);

  /* secure-context-only capabilities */
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? (reg.active?.state ?? 'registered') : 'none';
  });
  note(sw !== 'none', `service worker present (${sw})`);

  const vapid = await page.evaluate(async () => {
    const r = await fetch('/api/push/key');
    return r.ok ? (await r.json()).publicKey : null;
  });
  note(!!vapid, 'VAPID key fetched over HTTPS');

  note(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
  for (const e of consoleErrors.slice(0, 3)) console.log(`      · ${e}`);

  await page.screenshot({ path: join(SHOTS, 'https-session.png'), fullPage: true });
} catch (err) {
  problems.push(`FAILED: ${err.message}`);
  await page.screenshot({ path: join(SHOTS, 'https-error.png'), fullPage: true }).catch(() => {});
} finally {
  console.log(`\n─── ${problems.length ? problems.length + ' PROBLEM(S)' : 'ALL CLEAR'} ───`);
  for (const p of problems) console.log(`  · ${p}`);
  await browser.close();
  process.exit(problems.length ? 1 : 0);
}
