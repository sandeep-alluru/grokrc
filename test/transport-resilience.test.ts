/**
 * Transport resilience: what happens when the agent process dies underneath us.
 *
 * `StdioTransport.send()` writes to the child's stdin with no error handler on
 * that stream. An unhandled 'error' event on a Node stream is thrown, so an
 * EPIPE — the agent exited between its death and the `close` event reaching us —
 * would take the whole daemon down, not just that session.
 *
 * The daemon runs as a systemd service holding every other session, so "one
 * agent exits at the wrong moment" must never be able to kill it.
 *
 * Written before the fix (directive 07).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { StdioTransport, NdjsonDecoder } from '../src/acp/transport.ts';
import type { JsonRpcMessage } from '../src/acp/protocol.ts';

/**
 * Stand-in agent binary for transport tests.
 *
 * Both tests below used `true` / `sh -c 'exit 0'` in `/tmp`. Neither exists on
 * Windows, so `spawn` failed on the CWD before any child ran and the EPIPE race
 * these tests exist to provoke never happened. They passed anyway — through the
 * spawn-error path — which made the `stdin-error-handler` guard UNPROVABLE
 * there: `verify-guards` removed the handler and the tests still passed,
 * reporting a control that could not be shown to be doing any work.
 *
 * `StdioTransport` always prepends grok flags (`--permission-mode default`,
 * `agent`, `stdio`) before any extra args. Spawning `process.execPath` with
 * `-e '…'` therefore becomes `node --permission-mode default agent stdio -e …`,
 * which Node rejects as a bad option. The stand-in must be the **command**
 * itself so those argv slots are ignored by our script rather than by Node.
 */
async function writeStandIn(source: string): Promise<{ dir: string; command: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'grokrc-epipe-'));
  const command = join(dir, 'agent-standin');
  await writeFile(command, `#!/usr/bin/env node\n${source}`);
  await chmod(command, 0o755);
  return { dir, command };
}

/** Wait for a condition, or give up. */
async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('writing to a dead agent surfaces an error event, and does not throw', async () => {
  // A process that exits immediately — the agent is gone before we ever write.
  const { dir, command } = await writeStandIn('process.exit(0);\n');
  const t = new StdioTransport({ command, cwd: dir });
  const errors: Error[] = [];
  t.on('error', (e) => errors.push(e));

  await until(() => false, 400); // let the child exit

  // Must not throw synchronously, and must not raise an unhandled stream error.
  assert.doesNotThrow(() => {
    try {
      t.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    } catch (err) {
      // A thrown "transport closed" is acceptable — a CRASH is not.
      assert.match((err as Error).message, /closed/i);
    }
  });

  await until(() => errors.length > 0, 1500);
  t.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * A stand-in agent that closes its own stdin and then STAYS ALIVE.
 *
 * 1. IT IS THE COMMAND. `StdioTransport` always spawns
 *    `<command> --permission-mode default agent stdio …`. If `command` is Node
 *    and the script is a cwd file named `agent`, Node never reaches that file —
 *    it dies on the unknown `--permission-mode` flag first (measured 2026-08-12
 *    after the Windows permission-mode default landed). The stand-in is
 *    therefore the executable itself and ignores the grok-shaped argv.
 *
 * 2. IT STAYS ALIVE. Racing a dying process cannot work: `send()` checks
 *    `stdin.writable` first, and once a child has exited that flag is already
 *    false, so the write never reaches the pipe. With the child alive, the
 *    parent's write end stays writable while the read end is gone — exactly
 *    the kernel condition for EPIPE.
 */
const AGENT_SRC =
  'require("fs").closeSync(0);\n' +
  'process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"ready"})+"\\n");\n' +
  // Bounded, not immortal: the child must never be able to outlive the test.
  'setTimeout(()=>process.exit(0),10000);\n';

test('an EPIPE on agent stdin becomes an error event, not a crash', async (t) => {
  // Measured on Windows: even with a child that closed fd 0 and stayed alive,
  // every send() took the `stdin.writable === false` path and never called
  // stdin.write — so no EPIPE, no 'error' event. The control still exists in
  // production code and is proven load-bearing on POSIX (verify-guards
  // onlyOn: 'posix'). Running this assertion here fails the whole file's
  // baseline and falsely marks the unrelated ndjson-line-ceiling guard as
  // unproven on Windows.
  if (process.platform === 'win32') {
    t.skip('EPIPE path not reachable on Windows pipes — proven on posix only');
    return;
  }

  const { dir, command } = await writeStandIn(AGENT_SRC);
  const transport = new StdioTransport({ command, cwd: dir });

  const errors: Error[] = [];
  let ready = false;
  transport.on('error', (e) => errors.push(e));
  transport.on('message', (m: JsonRpcMessage) => {
    if ((m as { method?: string }).method === 'ready') ready = true;
  });

  assert.equal(
    await until(() => ready, 8000),
    true,
    'the stand-in agent never signalled that it had closed stdin'
  );

  // Large enough to pass the pipe buffer, so the failure surfaces rather than
  // being quietly absorbed by the kernel.
  // One write past the pipe buffer is enough. Queuing more only leaves unsent
  // bytes on a broken pipe, which keeps the handle — and the whole test run —
  // alive after close().
  const big = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 3 && errors.length === 0; i++) {
    try {
      transport.send({ jsonrpc: '2.0', id: i, method: 'noop', params: { big } });
    } catch {
      /* once `writable` flips, send() refuses — the error EVENT is the subject */
    }
    await until(() => errors.length > 0, 500);
  }

  // Without the stdin 'error' listener Node throws the unhandled stream error
  // and this process DIES rather than failing — which is the crash the control
  // exists to prevent, and how verify-guards detects the control is load-bearing.
  assert.ok(errors.length > 0, 'a broken agent stdin must surface as an error event');
  assert.match(
    errors.map((e) => e.message).join(' | '),
    /EPIPE|stdin/i,
    'the error should name the broken pipe'
  );

  transport.close();
  await rm(dir, { recursive: true, force: true });
});

test('a large but legitimate partial frame is still buffered', () => {
  // ACP frames really do run to megabytes (session/load replay, big tool
  // output). Dropping those would be worse than the bug — so the ceiling must
  // be generous, and this asserts it is.
  const dec = new NdjsonDecoder();
  dec.push(
    'x'.repeat(2 * 1024 * 1024),
    () => {},
    () => {}
  );
  assert.equal(dec.pending.length, 2 * 1024 * 1024, 'a 2 MiB partial frame must survive');
});

test('an unterminated line is dropped once it passes the ceiling', () => {
  // The property is BOUNDED, not small. An earlier version of this test
  // asserted an arbitrary 2 MiB bound and failed against correct code — the
  // detector was wrong, not the implementation.
  const dec = new NdjsonDecoder();
  const errs: Error[] = [];
  dec.push(
    'x'.repeat(9 * 1024 * 1024),
    () => {},
    (_l, e) => errs.push(e)
  );

  assert.equal(dec.pending.length, 0, 'buffer should have been dropped');
  assert.equal(errs.length, 1, 'the drop must be reported, not silent');
  assert.match(errs[0]!.message, /exceeded .* bytes/);
});

test('the decoder still works after dropping an oversized line', () => {
  // Dropping must not wedge it — the next well-formed frame has to arrive.
  const dec = new NdjsonDecoder();
  const got: JsonRpcMessage[] = [];
  dec.push(
    'x'.repeat(9 * 1024 * 1024),
    (m) => got.push(m),
    () => {}
  );
  dec.push(
    '{"jsonrpc":"2.0","method":"after"}\n',
    (m) => got.push(m),
    () => {}
  );

  assert.equal(got.length, 1);
  assert.equal((got[0] as { method: string }).method, 'after');
});
