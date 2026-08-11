/**
 * The test harness must not write into the developer's own Grok history.
 *
 * A real `grok` records every session under GROK_HOME and keeps it forever.
 * Two real-stack checks — live-ui-check and resume-check — booted a real agent
 * against the owner's actual `~/.grok`, so every `npm test` left a session
 * behind. Eighty accumulated. Each pointed at a scratch directory that had since
 * been deleted, and each was therefore able to crash the daemon on resume
 * (see test/spawn-failure.test.ts).
 *
 * `isolatedGrokHome()` already existed and one of the three tools used it. A
 * comment asking the next author to remember would be forgotten the same way,
 * so `bootDaemon()` refuses instead. This test is the guard on the guard.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A URL, not a path: `import()` of `C:\...` is rejected as an unknown URL
// scheme on Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME), so every test in this
// file errored before reaching its assertions.
const HARNESS = pathToFileURL(resolve(import.meta.dirname, '../tools/harness.mjs')).href;

test('bootDaemon refuses a REAL agent pointed at your own ~/.grok', async () => {
  const { bootDaemon } = await import(HARNESS);
  const saved = process.env.GROK_HOME;
  delete process.env.GROK_HOME; // the exact state the two tools were in
  try {
    // If the guard is gone, bootDaemon() SUCCEEDS and boots a real agent whose
    // open handles keep the runner alive — the file hangs instead of failing.
    // Close whatever came back so the failure is reported, not waited on.
    let leaked;
    await assert
      .rejects(
        async () => {
          leaked = await bootDaemon();
        },
        /isolatedGrokHome|your own ~\/\.grok/,
        'a real agent was allowed to write into the developer’s Grok history'
      )
      .finally(async () => {
        await leaked?.close?.().catch(() => {});
      });
  } finally {
    if (saved === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = saved;
  }
});

test('it also refuses when GROK_HOME is explicitly the real one', async () => {
  const { bootDaemon } = await import(HARNESS);
  const saved = process.env.GROK_HOME;
  process.env.GROK_HOME = join(process.env.HOME ?? '', '.grok');
  try {
    let leaked;
    await assert
      .rejects(async () => {
        leaked = await bootDaemon();
      }, /isolatedGrokHome|your own ~\/\.grok/)
      .finally(async () => {
        await leaked?.close?.().catch(() => {});
      });
  } finally {
    if (saved === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = saved;
  }
});

test('a mock transport is allowed without an isolated home — it never spawns', async () => {
  // Guard against over-correcting: the browser tests pass a transportFactory and
  // spawn nothing, so requiring isolation from them would be pure friction.
  const { bootDaemon, cleanup } = await import(HARNESS);
  const { MockTransport } = await import('../src/acp/mock-transport.ts');
  const saved = process.env.GROK_HOME;
  delete process.env.GROK_HOME;
  try {
    const daemon = await bootDaemon({
      transportFactory: () => new MockTransport({ sessionId: 'iso-1' }),
    });
    assert.ok(daemon.port > 0, 'a mocked daemon should boot without an isolated GROK_HOME');
    await daemon.close();
    await cleanup();
  } finally {
    if (saved === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = saved;
  }
});
