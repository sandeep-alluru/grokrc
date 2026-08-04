/**
 * Input hardening on the session paths.
 *
 * `observe` and `resume` take a sessionId and a cwd straight from the client and
 * turn them into a filesystem path and a process spawn directory. Both are
 * behind device auth, but a paired phone should still not be able to read
 * arbitrary paths or start an agent in an arbitrary directory — a stolen or
 * borrowed device shouldn't escalate into filesystem access.
 *
 * These assert the boundary directly rather than trusting that the UI only ever
 * sends well-formed values.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-sec-'));
process.env.GROKRC_HOME = tmp;

const { SessionManager } = await import('../src/daemon/session-manager.ts');

const sessions = new SessionManager();

after(async () => {
  sessions.closeAll();
  await rm(tmp, { recursive: true, force: true });
});

const TRAVERSAL_IDS = [
  '../../../../etc',
  '..',
  '../..',
  'a/../../b',
  'foo/bar',
  './x',
  '',
  'x'.repeat(300),
];

for (const id of TRAVERSAL_IDS) {
  test(`observe rejects a malformed session id: ${JSON.stringify(id.slice(0, 24))}`, async () => {
    await assert.rejects(
      () => sessions.observe(id, '/tmp'),
      /invalid session id/i,
      `observe accepted ${JSON.stringify(id)}`
    );
  });
}

for (const id of ['../../../../etc', 'foo/bar', '']) {
  test(`resume rejects a malformed session id: ${JSON.stringify(id)}`, async () => {
    await assert.rejects(() => sessions.resume(id, '/tmp'), /invalid session id/i);
  });
}

test('observe rejects a relative cwd', async () => {
  await assert.rejects(
    () => sessions.observe('019fcd7a-035c-7ab0-8999-a4c62160a35e', 'relative/path'),
    /absolute/i
  );
});

test('resume refuses a session that does not exist on disk', async () => {
  // Bounds the spawn directory to somewhere grok has actually run, instead of
  // letting a client name any directory on the machine.
  await assert.rejects(
    () => sessions.resume('019fcd7a-035c-7ab0-8999-a4c62160a35e', '/etc'),
    /no persisted session/i
  );
});

test('a well-formed id and absolute cwd are accepted', async () => {
  // Nonexistent session, but the SHAPE is valid — observe tolerates a missing
  // log because a session directory can appear before its log does.
  const info = await sessions.observe('019fcd7a-035c-7ab0-8999-a4c62160a35e', '/tmp/nonexistent');
  assert.equal(info.mode, 'observed');
  sessions.unobserve('019fcd7a-035c-7ab0-8999-a4c62160a35e');
});
