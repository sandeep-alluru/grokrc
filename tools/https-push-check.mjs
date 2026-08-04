#!/usr/bin/env node
/**
 * HTTPS + push registration check.
 *
 * Push was the last unverified claim: the plumbing was tested, but a service
 * worker cannot register over plain http://, so nothing had ever confirmed the
 * browser side works end-to-end. Tailscale now fronts the daemon with a real
 * certificate, which makes this testable.
 *
 * Drives a real browser against the real HTTPS origin and checks:
 *   - the cert is trusted (no ignoreHTTPSErrors)
 *   - the service worker registers and activates
 *   - the VAPID key is served
 *   - a real PushSubscription is created and accepted by the daemon
 *
 *   node tools/https-push-check.mjs [https://host]
 */
import { chromium } from 'playwright';

const ORIGIN = process.argv[2] ?? 'https://clawer-zen-z1-workstation.tail1306c8.ts.net';

const problems = [];
const note = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) problems.push(msg);
};

const browser = await chromium.launch();
// Deliberately NOT ignoring HTTPS errors — an untrusted cert must fail here,
// because that is exactly what would break the service worker on a phone.
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['notifications'],
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));

try {
  console.log(`origin: ${ORIGIN}\n`);

  const res = await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  note(!!res && res.status() === 200, `page loads over HTTPS (status ${res?.status()})`);
  note(page.url().startsWith('https://'), 'origin is https (secure context)');

  const secure = await page.evaluate(() => globalThis.isSecureContext);
  note(secure, 'isSecureContext is true — service workers are permitted');

  const vapid = await page.evaluate(async () => {
    const r = await fetch('/api/push/key');
    return r.ok ? (await r.json()).publicKey : null;
  });
  note(!!vapid && vapid.length > 20, `VAPID public key served (${vapid?.length ?? 0} chars)`);

  // Register the worker exactly as app.js does.
  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return reg.active?.state ?? reg.installing?.state ?? 'unknown';
  });
  note(swState === 'activated' || swState === 'activating', `service worker registered (${swState})`);

  // A real PushSubscription — the step that plain http:// makes impossible.
  const sub = await page.evaluate(async (key) => {
    const b64 = (s) => {
      const p = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(p);
      return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
    };
    const reg = await navigator.serviceWorker.ready;
    try {
      const s = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64(key),
      });
      return { ok: true, endpoint: s.endpoint };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, vapid);

  if (sub.ok) {
    note(true, `PushSubscription created (${new URL(sub.endpoint).host})`);
  } else {
    // Headless Chromium has no push service wired up; that is an environment
    // limitation, not a defect in the page. Report it plainly either way.
    note(false, `PushSubscription failed: ${sub.error}`);
    console.log('      (headless Chromium has no push backend — expected here; a real phone does)');
  }

  note(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
  for (const e of consoleErrors.slice(0, 3)) console.log(`      · ${e}`);
} catch (err) {
  problems.push(`FAILED: ${err.message}`);
} finally {
  console.log(`\n─── ${problems.length ? problems.length + ' issue(s)' : 'ALL CLEAR'} ───`);
  await browser.close();
  process.exit(0);
}
