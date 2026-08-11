/**
 * A failed write to `~/.grokrc` must not kill the daemon.
 *
 * The daemon is a long-lived process holding every live session. Four paths
 * wrote to the config directory without guarding the write, and each of them
 * ran on ordinary traffic:
 *
 *   auth.verify()        -> `void this.#save()`         every WebSocket `hello`
 *   push.notify*()       -> #send -> #save()            an expired subscription
 *   #handlePair          -> redeem() -> #save()         a phone pairing
 *   #handleSubscribe     -> subscribe() -> #save()      enabling notifications
 *
 * The first two are fire-and-forget, so a rejection had no handler at all and
 * Node terminated the process. The other two reject out of
 * `void this.#onHttp(...)`, with the same result — and the client is left
 * waiting for a response that never comes.
 *
 * REPRODUCED before the fix. `auth.verify()` and `push.notifyDone()` each
 * killed a real process with `EISDIR ... at async #save`, and the scenarios
 * below print SURVIVED only if the daemon is still standing.
 *
 * Why a write fails in practice: antivirus holding the file on Windows, a full
 * disk, a revoked permission, a network home directory that dropped. None of
 * those should cost you every running session.
 *
 * The failure is injected by replacing the store with a DIRECTORY — a real
 * filesystem condition, not a stubbed `fs`. Under directive 03 a mock here
 * would prove nothing about production.
 *
 * Each case runs in its own process: an unhandled rejection kills the runner
 * itself, so an in-process assertion could not tell "threw" from "died".
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const url = (p: string) => pathToFileURL(resolve(import.meta.dirname, '..', p)).href;
const AUTH = url('src/daemon/auth.ts');
const PUSH = url('src/daemon/push.ts');
const SERVER = url('src/daemon/server.ts');

async function runScenario(code: string, env: Record<string, string>) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', code],
      { env: { ...process.env, ...env }, timeout: 60_000 }
    );
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

/** A config dir whose device store cannot be written: it is a directory. */
async function homeWithUnwritableStore(file: string) {
  const home = await mkdtemp(join(tmpdir(), 'grokrc-writefail-'));
  await mkdir(join(home, file));
  return home;
}

const TOKEN = 'deadbeef'.repeat(8);
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

test('verify() survives a device-store write failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'grokrc-writefail-'));
  const store = join(home, 'devices.json');
  await writeFile(
    store,
    JSON.stringify({
      devices: [{ id: 'dev1', name: 'phone', tokenHash: TOKEN_HASH, pairedAt: 1, lastSeen: 1 }],
    })
  );

  const res = await runScenario(
    `
    const { AuthStore } = await import(${JSON.stringify(AUTH)});
    const { rm, mkdir } = await import('node:fs/promises');
    const auth = new AuthStore();
    await auth.load();
    // Break writes only AFTER load, so the device is in memory.
    await rm(${JSON.stringify(store)}, { force: true });
    await mkdir(${JSON.stringify(store)});
    const device = await auth.verify(${JSON.stringify(TOKEN)});
    console.log('verified: ' + (device ? device.id : 'null'));
    await new Promise((r) => setTimeout(r, 700));
    console.log('SURVIVED');
    process.exit(0);
    `,
    { GROKRC_HOME: home }
  );

  await rm(home, { recursive: true, force: true });
  assert.match(res.out, /verified: dev1/, `the token must still authenticate:\n${res.out}`);
  assert.match(res.out, /SURVIVED/, `the daemon died on a lastSeen write:\n${res.out}`);
  assert.equal(res.code, 0, `non-zero exit means the process was killed:\n${res.out}`);
});

test('pairing over HTTP survives a device-store write failure', async () => {
  // The whole point of the daemon: a phone pairs, the store cannot be written,
  // and every OTHER session keeps running.
  const home = await homeWithUnwritableStore('devices.json');

  const res = await runScenario(
    `
    const { AuthStore } = await import(${JSON.stringify(AUTH)});
    const { RemoteControlServer } = await import(${JSON.stringify(SERVER)});
    const { SessionManager } = await import(${JSON.stringify(url('src/daemon/session-manager.ts'))});
    const auth = new AuthStore();
    await auth.load();
    const { code } = auth.beginPairing();
    const server = new RemoteControlServer({
      host: '127.0.0.1', port: 0,
      webRoot: ${JSON.stringify(resolve(import.meta.dirname, '..', 'web'))},
      sessions: new SessionManager(), auth,
      defaultCwd: ${JSON.stringify(tmpdir())},
    });
    const { port } = await server.listen();
    const r = await fetch('http://127.0.0.1:' + port + '/api/pair', {
      method: 'POST',
      body: JSON.stringify({ code, deviceName: 'phone' }),
    });
    console.log('pair responded: ' + r.status);
    await new Promise((res2) => setTimeout(res2, 700));
    console.log('SURVIVED');
    await server.close();
    process.exit(0);
    `,
    { GROKRC_HOME: home }
  );

  await rm(home, { recursive: true, force: true });
  assert.match(
    res.out,
    /pair responded: \d+/,
    `the client must get an answer, not hang:\n${res.out}`
  );
  assert.match(res.out, /SURVIVED/, `the daemon died while pairing:\n${res.out}`);
  assert.equal(res.code, 0, `non-zero exit means the process was killed:\n${res.out}`);
});

test('a client that aborts mid-request does not kill the daemon', async () => {
  // The same unguarded-rejection class, reached by something far more ordinary
  // than a disk failure: `readBody` iterates the request stream, and an aborted
  // upload makes that iterator throw. A phone on flaky cellular dropping a
  // POST /api/pair is a Tuesday, not an edge case.
  //
  // No broken filesystem here — the store is writable. The only fault is the
  // client going away mid-body.
  const home = await mkdtemp(join(tmpdir(), 'grokrc-abort-'));

  const res = await runScenario(
    `
    const { connect } = await import('node:net');
    const { AuthStore } = await import(${JSON.stringify(AUTH)});
    const { RemoteControlServer } = await import(${JSON.stringify(SERVER)});
    const { SessionManager } = await import(${JSON.stringify(url('src/daemon/session-manager.ts'))});

    const auth = new AuthStore();
    await auth.load();
    const server = new RemoteControlServer({
      host: '127.0.0.1', port: 0,
      webRoot: ${JSON.stringify(resolve(import.meta.dirname, '..', 'web'))},
      sessions: new SessionManager(), auth,
      defaultCwd: ${JSON.stringify(tmpdir())},
    });
    const { port } = await server.listen();

    // Promise a body, deliver part of it, then vanish.
    await new Promise((done) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(
          'POST /api/pair HTTP/1.1\\r\\n' +
          'Host: 127.0.0.1\\r\\n' +
          'Content-Length: 400\\r\\n' +
          '\\r\\n' +
          '{"code":"AAAAAA"'
        );
        setTimeout(() => { sock.destroy(); done(); }, 120);
      });
      sock.on('error', () => done());
    });
    console.log('client aborted mid-body');

    await new Promise((r) => setTimeout(r, 700));
    // Still serving? That is the whole claim.
    const health = await (await fetch('http://127.0.0.1:' + port + '/api/health')).json();
    console.log('still serving: ' + JSON.stringify(health));
    console.log('SURVIVED');
    await server.close();
    process.exit(0);
    `,
    { GROKRC_HOME: home }
  );

  await rm(home, { recursive: true, force: true });
  assert.match(res.out, /client aborted mid-body/, `setup did not run:\n${res.out}`);
  assert.match(res.out, /"ok":true/, `the daemon stopped serving after an abort:\n${res.out}`);
  assert.match(res.out, /SURVIVED/, `an aborted request killed the daemon:\n${res.out}`);
  assert.equal(res.code, 0, `non-zero exit means the process was killed:\n${res.out}`);
});

test('enabling notifications survives a subscription-store write failure', async () => {
  // Same sink as the notify path: PushService.#save().
  //
  // The first version of this test called `push.subscribe()` directly inside a
  // try/catch — so it caught the very rejection it was meant to detect and
  // PASSED against the unfixed code, while the two tests beside it failed. A
  // test that passes without the control measures nothing (G3 law 6). It now
  // goes through `/api/push/subscribe`, which is the path a phone actually
  // takes and the one where nothing awaits the promise.
  //
  // devices.json stays writable here — the device has to pair first. Only the
  // subscription store is broken.
  const home = await homeWithUnwritableStore('push-subscriptions.json');

  const res = await runScenario(
    `
    const { AuthStore } = await import(${JSON.stringify(AUTH)});
    const { PushService } = await import(${JSON.stringify(PUSH)});
    const { RemoteControlServer } = await import(${JSON.stringify(SERVER)});
    const { SessionManager } = await import(${JSON.stringify(url('src/daemon/session-manager.ts'))});

    const auth = new AuthStore();
    await auth.load();
    const push = new PushService();
    await push.load();

    const server = new RemoteControlServer({
      host: '127.0.0.1', port: 0,
      webRoot: ${JSON.stringify(resolve(import.meta.dirname, '..', 'web'))},
      sessions: new SessionManager(), auth, push,
      defaultCwd: ${JSON.stringify(tmpdir())},
    });
    const { port } = await server.listen();
    const base = 'http://127.0.0.1:' + port;

    const { code } = auth.beginPairing();
    const paired = await (await fetch(base + '/api/pair', {
      method: 'POST',
      body: JSON.stringify({ code, deviceName: 'phone' }),
    })).json();

    const r = await fetch(base + '/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        token: paired.token,
        subscription: { endpoint: 'https://example.invalid/x', keys: { p256dh: 'x', auth: 'y' } },
      }),
    });
    console.log('subscribe responded: ' + r.status);
    await new Promise((res2) => setTimeout(res2, 700));
    console.log('SURVIVED');
    await server.close();
    process.exit(0);
    `,
    { GROKRC_HOME: home }
  );

  await rm(home, { recursive: true, force: true });
  assert.match(
    res.out,
    /subscribe responded: \d+/,
    `the client must get an answer, not hang:\n${res.out}`
  );
  assert.match(res.out, /SURVIVED/, `the daemon died on a subscription write:\n${res.out}`);
  assert.equal(res.code, 0, `non-zero exit means the process was killed:\n${res.out}`);
});
