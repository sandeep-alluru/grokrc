/**
 * Control socket — the CLI talking to a running daemon.
 *
 * Pairing codes live in the daemon's memory: `beginPairing()` writes them there
 * and `redeem()` reads them from there. Before this existed, `grokrc pair` could
 * only tell you to restart with `--pair`, which drops every live session to hand
 * out six characters.
 *
 * These tests assert the whole chain: a code minted over the socket must be
 * redeemable against the SAME AuthStore instance the daemon is using. A test
 * that only checked the code came back would pass against an implementation
 * that minted it in the wrong process.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-control-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { ControlServer, ControlUnavailableError, controlRequest, daemonRunning } =
  await import('../src/daemon/control.ts');

const SOCK = join(tmp, 'control.sock');

let auth: InstanceType<typeof AuthStore>;
let server: InstanceType<typeof ControlServer>;
const connected = new Set<string>();

before(async () => {
  auth = new AuthStore();
  await auth.load();

  server = new ControlServer(
    {
      pair: () => auth.beginPairing(),
      devices: () =>
        auth.devices.map((d) => ({
          id: d.id,
          name: d.name,
          pairedAt: d.pairedAt,
          lastSeen: d.lastSeen,
          connected: connected.has(d.id),
        })),
      revoke: (id) => auth.revoke(id),
      revokeAll: async () => {
        const n = auth.devices.length;
        await auth.revokeAll();
        return n;
      },
      status: () => ({ version: 'test', sessions: 0 }),
    },
    SOCK
  );
  await server.listen();
});

after(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

test('ping reaches a running daemon', async () => {
  assert.deepEqual(await controlRequest('ping', undefined, SOCK), { pong: true });
  assert.equal(await daemonRunning(SOCK), true);
});

test('a code minted over the socket is redeemable by the daemon', async () => {
  const { code, expiresAt } = await controlRequest<{ code: string; expiresAt: number }>(
    'pair',
    undefined,
    SOCK
  );

  assert.match(code, /^[A-Z2-9]{6}$/, `unexpected code shape: ${code}`);
  assert.ok(expiresAt > Date.now(), 'code should not arrive already expired');

  // The point of the whole feature: the daemon's own store must accept it.
  const redeemed = await auth.redeem(code, 'test-phone');
  assert.ok(redeemed, 'the daemon did not recognise the code it just issued');
  assert.ok(redeemed!.token.length >= 32);
});

test('a code is single use', async () => {
  const { code } = await controlRequest<{ code: string }>('pair', undefined, SOCK);
  assert.ok(await auth.redeem(code, 'first'));
  assert.equal(await auth.redeem(code, 'second'), null, 'a spent code must not redeem twice');
});

test('devices lists what the daemon has, with live connection state', async () => {
  const { code } = await controlRequest<{ code: string }>('pair', undefined, SOCK);
  const redeemed = await auth.redeem(code, 'listed-device');
  connected.add(redeemed!.device.id);

  const { devices } = await controlRequest<{ devices: Array<Record<string, unknown>> }>(
    'devices',
    undefined,
    SOCK
  );
  const found = devices.find((d) => d.id === redeemed!.device.id);
  assert.ok(found, 'the newly paired device should be listed');
  assert.equal(found!.name, 'listed-device');
  // Connection state is the thing reading auth.json off disk CANNOT provide.
  assert.equal(found!.connected, true);
});

test('revoke removes the device from the running daemon', async () => {
  const { code } = await controlRequest<{ code: string }>('pair', undefined, SOCK);
  const redeemed = await auth.redeem(code, 'doomed');
  const id = redeemed!.device.id;

  assert.ok(await auth.verify(redeemed!.token), 'token should work before revoke');

  const res = await controlRequest<{ revoked: number }>('revoke', { deviceId: id }, SOCK);
  assert.equal(res.revoked, 1);
  assert.equal(await auth.verify(redeemed!.token), null, 'revoked token must stop working');
});

test('revoke reports 0 for an unknown device rather than throwing', async () => {
  const res = await controlRequest<{ revoked: number }>(
    'revoke',
    { deviceId: 'nope-not-real' },
    SOCK
  );
  assert.equal(res.revoked, 0);
});

test('unknown commands are refused, not silently ignored', async () => {
  await assert.rejects(
    () => controlRequest('definitely-not-a-command', undefined, SOCK),
    /unknown command/
  );
});

test('malformed params are refused', async () => {
  await assert.rejects(() => controlRequest('revoke', {}, SOCK), /deviceId required/);
});

test('the socket is owner-only', async () => {
  const st = await stat(SOCK);
  const mode = st.mode & 0o777;
  assert.equal(
    mode & 0o077,
    0,
    `control socket is group/world accessible (mode ${mode.toString(8)}) — anyone on the box could mint a pairing code`
  );
});

test('no daemon means ControlUnavailableError, so callers can fall back', async () => {
  const missing = join(tmp, 'does-not-exist.sock');
  await assert.rejects(
    () => controlRequest('ping', undefined, missing),
    (err: Error) => err instanceof ControlUnavailableError
  );
  assert.equal(await daemonRunning(missing), false);
});

test('a stale socket file left by a crashed daemon is reclaimed', async () => {
  const stale = join(tmp, 'stale.sock');
  // A plain file standing where a socket should be: bind() would fail with
  // EADDRINUSE and the daemon would refuse to start, forever.
  await writeFile(stale, '');
  await chmod(stale, 0o600);

  const s2 = new ControlServer(
    {
      pair: () => auth.beginPairing(),
      devices: () => [],
      revoke: async () => false,
      revokeAll: async () => 0,
      status: () => ({}),
    },
    stale
  );
  await s2.listen();
  try {
    assert.deepEqual(await controlRequest('ping', undefined, stale), { pong: true });
  } finally {
    await s2.close();
  }
});

test('a live socket is NOT stolen from a running daemon', async () => {
  const s2 = new ControlServer(
    {
      pair: () => auth.beginPairing(),
      devices: () => [],
      revoke: async () => false,
      revokeAll: async () => 0,
      status: () => ({}),
    },
    SOCK // the socket the first server is already serving
  );
  await assert.rejects(() => s2.listen(), /already running/);

  // And the original must be unharmed — the stale-socket path must not have
  // unlinked a live daemon's socket on its way to failing.
  assert.deepEqual(await controlRequest('ping', undefined, SOCK), { pong: true });
});

test('close() removes the socket file', async () => {
  const path = join(tmp, 'transient.sock');
  const s2 = new ControlServer(
    {
      pair: () => auth.beginPairing(),
      devices: () => [],
      revoke: async () => false,
      revokeAll: async () => 0,
      status: () => ({}),
    },
    path
  );
  await s2.listen();
  await stat(path); // exists
  await s2.close();
  await assert.rejects(() => stat(path), /ENOENT/);
});
