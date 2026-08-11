/**
 * What `grokrc up` tells you about who can reach it.
 *
 * Remote control of a coding agent is remote code execution, so the one line
 * describing exposure is load-bearing safety text, not decoration.
 *
 * The bug: the notice was a two-way branch on `host === '0.0.0.0'`, and
 * everything else was announced as "loopback only". Binding to this machine's
 * own Tailscale address printed
 *
 *     loopback only. Use --lan to reach it from your phone, or tunnel it.
 *
 * while the daemon was reachable from every machine on the tailnet — and a live
 * check from another address then drove a real session through it. Understating
 * exposure is the failure direction that matters here.
 *
 * The tests below are paired: every "this is exposed" case has a loopback case
 * beside it, because a notice that always warns is as useless as one that never
 * does.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const { exposureNotice } = await import('../src/cli.ts');

/* ─── exposed ─────────────────────────────────────────────────────────────── */

test('binding all interfaces warns', () => {
  assert.match(exposureNotice('0.0.0.0', '192.168.1.24'), /⚠/);
  assert.match(exposureNotice('0.0.0.0', '192.168.1.24'), /all interfaces/);
});

test('the IPv6 any-address warns too', () => {
  // `::` is the v6 spelling of 0.0.0.0 and was not handled at all.
  assert.match(exposureNotice('::', '::'), /⚠/);
});

test('a Tailscale address is reported as reachable, not as loopback', () => {
  // The exact case that exposed this: a real tailnet address the daemon was
  // bound to while announcing itself as loopback-only.
  const notice = exposureNotice('100.119.149.50', '100.119.149.50');
  assert.match(notice, /⚠/, 'a routable bind address must warn');
  assert.doesNotMatch(notice, /loopback only/, 'it is not loopback — saying so is the bug');
  assert.match(notice, /100\.119\.149\.50/, 'name the address the user must think about');
});

test('any other routable address warns as well', () => {
  for (const host of ['192.168.1.24', '10.0.0.9', '203.0.113.7']) {
    assert.match(exposureNotice(host, host), /⚠/, `should warn for ${host}`);
  }
});

/* ─── not exposed — the control ───────────────────────────────────────────── */

test('genuine loopback is still reported as loopback', () => {
  // Without this, "always warn" would pass every test above while making the
  // warning meaningless.
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    const notice = exposureNotice(host, host);
    assert.match(notice, /loopback only/, `${host} is loopback`);
    assert.doesNotMatch(notice, /⚠/, `${host} must not warn`);
  }
});
