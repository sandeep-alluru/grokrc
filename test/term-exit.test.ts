/**
 * The terminal client must exit, not hang, when it never gets a session.
 *
 * An error arriving BEFORE any session is established is fatal: nothing has
 * started the input loop, so the process sits with no prompt, no way to type
 * and no way to quit but ctrl-C. That is what a refused resume looks like — the
 * common case, when the session is already live in a standalone terminal.
 *
 * Originally observed as `exit 124`: killed by timeout, having offered no
 * prompt at all.
 *
 * This drives the REAL CLI against a REAL daemon over a real socket. The only
 * thing stubbed is the agent, because the subject is the client's exit
 * behaviour and an agent would only add latency.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const tmp = await mkdtemp(join(tmpdir(), 'grokrc-term-'));
process.env.GROKRC_HOME = tmp;
process.env.GROK_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

const CLI = resolve(import.meta.dirname, '../src/cli.ts');

const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => new MockTransport({ sessionId: 'term-1' }),
});
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
  defaultCwd: tmp,
});
const { port } = await server.listen();

before(async () => {
  // A token the daemon will REJECT. That makes the daemon send an `error`
  // frame before any session exists, which is precisely the state the guard
  // covers. A valid token instead reaches a client-side pre-check
  // ("no session matching ..."), a different path that would leave the guard
  // untested while the file still went green.
  await writeFile(join(tmp, 'term-token'), 'not-a-valid-token', { mode: 0o600 });
});

after(async () => {
  sessions.closeAll();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

test('an error before any session exits, rather than hanging with no prompt', async () => {
  let code = 0;
  let out: string;
  try {
    // A success here IS the failure: the client should never exit 0 with no
    // session, so the assertions below run against whatever it printed.
    const r = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        CLI,
        'term',
        '--url',
        `ws://127.0.0.1:${port}`,
        '--session',
        'does-not-exist',
      ],
      { env: { ...process.env, GROKRC_HOME: tmp }, timeout: 30_000 }
    );
    out = r.stdout + r.stderr;
  } catch (err) {
    const e = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
    out = (e.stdout ?? '') + (e.stderr ?? '');
    // `killed` true means the timeout fired — the exact hang this guards
    // against. (`false || undefined` here asserted `=== undefined`, so a clean
    // non-zero exit, where killed is false, reported a hang that never
    // happened. The detector was wrong, not the client.)
    assert.notEqual(e.killed, true, `the client HUNG instead of exiting:\n${out}`);
    code = typeof e.code === 'number' ? e.code : 1;
  }

  assert.notEqual(code, 0, `expected a non-zero exit, got ${code}:\n${out}`);
  assert.match(
    out,
    /nothing to drive from here/i,
    `the client exited without explaining that no session was ever opened:\n${out}`
  );
});
