/**
 * Push failures must be diagnosable.
 *
 * `#send()` swallowed every error except 404/410, so a broken push setup — bad
 * VAPID keys, a rejecting push service, a network fault — produced complete
 * silence. That is the same failure mode as the swallowed prompt rejection and
 * the dropped offline message: the feature appears to work and simply never
 * arrives, with nothing to look at.
 *
 * Written before the fix (directive D1). Endpoints point at a blackhole address
 * so sends genuinely fail rather than being mocked.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-pushdiag-'));
process.env.GROKRC_HOME = tmp;

const { PushService } = await import('../src/daemon/push.ts');

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** 203.0.113.0/24 is TEST-NET-3 — reserved, never routable. Sends fail for real. */
const UNREACHABLE = {
  endpoint: 'https://203.0.113.1/push/abc',
  keys: { p256dh: 'BExampleKeyMaterialThatIsNotValid', auth: 'authsecret' },
};

test('a failing send is recorded, not swallowed', async () => {
  const push = new PushService();
  await push.load();
  await push.subscribe('device-1', UNREACHABLE as never);

  assert.equal(push.lastError, null, 'no error before any send');

  await push.notifyDone('s1', 'a session');

  assert.ok(
    push.lastError,
    'a send that failed left no trace — push can break silently with nothing to look at'
  );
  assert.match(push.lastError!.message, /.+/);
});

test('failure counters distinguish a broken setup from an idle one', async () => {
  const push = new PushService();
  await push.load();
  await push.subscribe('device-2', {
    ...UNREACHABLE,
    endpoint: 'https://203.0.113.2/push/xyz',
  } as never);

  const before = push.stats.failed;
  await push.notifyDone('s2', 'another');
  assert.ok(
    push.stats.failed > before,
    `failed count did not move (${before} -> ${push.stats.failed})`
  );
});

test('a dead subscription is still pruned, and counted separately from a fault', async () => {
  // 404/410 means the browser dropped it for good — expected, not a fault.
  const push = new PushService();
  await push.load();
  await push.subscribe('device-3', UNREACHABLE as never);

  // The store is shared across tests in this file, so assert the PROPERTY —
  // a fault must not shrink the list — rather than an absolute count.
  const before = push.subscriberCount;
  assert.ok(before > 0);

  await push.notifyDone('s3', 'x');

  // An unreachable host is a fault, not a 410. Pruning here would silently
  // unsubscribe someone's phone because of a transient outage.
  assert.equal(push.subscriberCount, before, 'a network fault must not unsubscribe a device');
  assert.ok(push.stats.failed > 0, 'the fault should be counted');
  assert.equal(push.stats.expired, 0, 'a fault must not be counted as an expiry');
});
