/**
 * Issuing a pairing code must not destroy the one being typed.
 *
 * There was a single pending slot, so `beginPairing()` overwrote the previous
 * code. The failure mode that produced was circular and expensive: hand over a
 * code, hear "invalid", helpfully issue another — which kills the code the user
 * is halfway through entering — and the next attempt is invalid for that very
 * reason. It cost the owner an hour and 29 half-finished device pairings.
 *
 * The daemon was never at fault, which is exactly why it took so long to see.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-pairing-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');

test('an older code still works after a newer one is issued', async () => {
  const auth = new AuthStore();
  await auth.load();

  const first = auth.beginPairing();
  const second = auth.beginPairing(); // the "helpful" second code
  assert.notEqual(first.code, second.code);

  const a = await auth.redeem(first.code, 'phone-typing-the-first-code');
  assert.ok(a, 'issuing a second code destroyed the first — the exact reported bug');

  const b = await auth.redeem(second.code, 'phone-using-the-second');
  assert.ok(b, 'the newer code must also still work');
  assert.notEqual(a!.device.id, b!.device.id);
});

test('each code is still single use', async () => {
  const auth = new AuthStore();
  await auth.load();
  const { code } = auth.beginPairing();
  assert.ok(await auth.redeem(code, 'first'));
  assert.equal(await auth.redeem(code, 'replay'), null, 'a spent code must not redeem twice');
});

test('a wrong code is refused while valid ones are outstanding', async () => {
  const auth = new AuthStore();
  await auth.load();
  auth.beginPairing();
  auth.beginPairing();
  assert.equal(await auth.redeem('ZZZZZZ', 'attacker'), null);
});

test('outstanding codes are bounded', async () => {
  // A loop issuing codes must not grow memory without limit.
  const auth = new AuthStore();
  await auth.load();
  const codes = Array.from({ length: 30 }, () => auth.beginPairing().code);

  const live = [];
  for (const c of codes) {
    const r = await auth.redeem(c, 'x');
    if (r) live.push(c);
  }
  assert.ok(live.length <= 8, `expected at most 8 outstanding, ${live.length} redeemed`);
  assert.ok(live.length >= 1, 'the most recent codes must survive');
  // The newest must always be usable — that is the one just handed to someone.
  assert.ok(live.includes(codes[codes.length - 1]!), 'the newest code was evicted');
});

test.after?.(async () => {
  await rm(tmp, { recursive: true, force: true });
});
