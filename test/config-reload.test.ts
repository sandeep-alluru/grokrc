/**
 * `config set` should tell the running daemon, not tell the user to restart it.
 *
 * It printed "restart to apply" unconditionally — including for settings a
 * running daemon reads per use and could have picked up instantly. The advice
 * was wrong for some keys and right for others, with no way to tell which.
 *
 * The honest part is the split. `defaultCwd`, `model` and `historyLimit` are
 * consulted per request or per session create, so they can change under a
 * running daemon. `host`, `port` and `lan` cannot: the socket is already bound,
 * and reporting them as applied would be a lie that only surfaces later, when
 * the daemon is still answering on the old port.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-reload-'));
process.env.GROKRC_HOME = tmp;

const { ControlServer, controlRequest } = await import('../src/daemon/control.ts');
const { applyReload } = await import('../src/daemon/config.ts');
type GrokrcConfig = import('../src/daemon/config.ts').GrokrcConfig;
const SOCK = join(tmp, 'control.sock');

/**
 * Recorders, not a reimplementation. The reload LOGIC under test is
 * `applyReload` from src/daemon/config.ts — production code. The previous
 * version of this file wrote its own `reload` handler and asserted against
 * that, so both controls in production could be deleted and this stayed green:
 * it was measuring itself. Verified by mutation — see tools/guards.mjs.
 */
const appliedTo: {
  defaultCwd?: string;
  historyLimit?: number;
  model?: string;
  useLeader?: boolean;
} = {};
const serverRecorder = {
  applyConfig(next: { defaultCwd?: string; historyLimit?: number }) {
    Object.assign(appliedTo, next);
  },
};
const sessionsRecorder = {
  applyConfig(next: { model?: string; useLeader?: boolean }) {
    Object.assign(appliedTo, next);
  },
};

const bootCfg = { defaultCwd: '/original', historyLimit: 10, port: 4319 } as GrokrcConfig;

const control = new ControlServer(
  {
    pair: () => ({ code: 'AAAAAA', expiresAt: Date.now() + 60_000 }),
    devices: () => [],
    revoke: async () => false,
    revokeAll: async () => 0,
    status: () => ({}),
    reload: async () => {
      const raw = await import('node:fs/promises').then((m) =>
        m.readFile(join(tmp, 'config.json'), 'utf8').catch(() => '{}')
      );
      const next = JSON.parse(raw) as GrokrcConfig;
      return applyReload(next, bootCfg, bootCfg.defaultCwd!, {
        server: serverRecorder,
        sessions: sessionsRecorder,
      });
    },
  },
  SOCK
);
await control.listen();

after(async () => {
  await control.close();
  await rm(tmp, { recursive: true, force: true });
});

test('a per-use setting is applied to the running daemon', async () => {
  // A complete config, because loadConfig() always returns one — a partial file
  // would make `port: undefined` look like a change and test the wrong thing.
  await writeFile(join(tmp, 'config.json'), JSON.stringify({ ...bootCfg, defaultCwd: '/changed' }));
  const r = await controlRequest<{ applied: string[]; needsRestart: string[] }>(
    'reload',
    undefined,
    SOCK
  );

  assert.deepEqual(r.applied, ['defaultCwd'], 'defaultCwd should apply without a restart');
  assert.equal(appliedTo.defaultCwd, '/changed', 'the daemon did not actually take the new value');
  assert.deepEqual(r.needsRestart, [], 'nothing here requires a restart');
});

test('a bound-socket setting is reported as needing a restart, not applied', async () => {
  // The lie this prevents: claiming success while the daemon still answers on
  // the old port.
  await writeFile(join(tmp, 'config.json'), JSON.stringify({ ...bootCfg, port: 5555 }));
  const r = await controlRequest<{ applied: string[]; needsRestart: string[] }>(
    'reload',
    undefined,
    SOCK
  );

  assert.ok(r.needsRestart.includes('port'), 'port must be reported as needing a restart');
  assert.ok(!r.applied.includes('port'), 'port must NOT be reported as applied');
});

test('a changed historyLimit reaches the daemon, not just the config file', async () => {
  // Test 1 only covers defaultCwd. Without this, the historyLimit branch could
  // be deleted outright and both tests stayed green — which is exactly the hole
  // that let the old, self-measuring version of this file pass.
  await writeFile(join(tmp, 'config.json'), JSON.stringify({ ...bootCfg, historyLimit: 999 }));
  const r = await controlRequest<{ applied: string[]; needsRestart: string[] }>(
    'reload',
    undefined,
    SOCK
  );

  assert.ok(r.applied.includes('historyLimit'), 'historyLimit should apply without a restart');
  assert.equal(appliedTo.historyLimit, 999, 'the daemon did not actually take the new limit');
});

test('an unchanged setting is not reported as applied', async () => {
  // "applied: historyLimit" on a reload that changed nothing trains the user to
  // ignore the line.
  await writeFile(join(tmp, 'config.json'), JSON.stringify(bootCfg));
  const r = await controlRequest<{ applied: string[]; needsRestart: string[] }>(
    'reload',
    undefined,
    SOCK
  );
  assert.deepEqual(r.applied, [], `nothing changed, so nothing should be applied: ${r.applied}`);
  assert.deepEqual(r.needsRestart, [], 'nothing changed, so nothing needs a restart');
});
