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
const SOCK = join(tmp, 'control.sock');

/** Stands in for the daemon: records what it was asked to apply. */
const appliedTo = {
  defaultCwd: '/original',
  historyLimit: 10,
  model: undefined as string | undefined,
};
const bootCfg = { defaultCwd: '/original', historyLimit: 10, port: 4319 };

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
      const next = JSON.parse(raw) as Record<string, unknown>;
      const applied: string[] = [];
      const needsRestart: string[] = [];
      if (typeof next.defaultCwd === 'string' && next.defaultCwd !== bootCfg.defaultCwd) {
        appliedTo.defaultCwd = next.defaultCwd;
        applied.push('defaultCwd');
      }
      if (typeof next.port === 'number' && next.port !== bootCfg.port) needsRestart.push('port');
      return { applied, needsRestart };
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
  await writeFile(join(tmp, 'config.json'), JSON.stringify({ defaultCwd: '/changed' }));
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
  await writeFile(join(tmp, 'config.json'), JSON.stringify({ port: 5555 }));
  const r = await controlRequest<{ applied: string[]; needsRestart: string[] }>(
    'reload',
    undefined,
    SOCK
  );

  assert.ok(r.needsRestart.includes('port'), 'port must be reported as needing a restart');
  assert.ok(!r.applied.includes('port'), 'port must NOT be reported as applied');
});
