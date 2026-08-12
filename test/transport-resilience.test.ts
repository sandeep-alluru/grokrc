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
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { StdioTransport, NdjsonDecoder } from '../src/acp/transport.ts';
import type { JsonRpcMessage } from '../src/acp/protocol.ts';

/**
 * A real process that exits immediately, and a directory that exists.
 *
 * Both tests below used `true` / `sh -c 'exit 0'` in `/tmp`. Neither exists on
 * Windows, so `spawn` failed on the CWD before any child ran and the EPIPE race
 * these tests exist to provoke never happened. They passed anyway — through the
 * spawn-error path — which made the `stdin-error-handler` guard UNPROVABLE
 * there: `verify-guards` removed the handler and the tests still passed,
 * reporting a control that could not be shown to be doing any work.
 *
 * `process.execPath` is the one executable guaranteed to be present on every
 * platform this runs on, and it can be told to exit immediately.
 */
const EXIT_NOW = { command: process.execPath, args: ['-e', 'process.exit(0)'] };
const WORKDIR = tmpdir();

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
  const t = new StdioTransport({ command: EXIT_NOW.command, args: EXIT_NOW.args, cwd: WORKDIR });
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
});

/**
 * A stand-in agent that closes its own stdin and then STAYS ALIVE.
 *
 * Two things make the EPIPE deterministic here, and both were missing before.
 *
 * 1. IT ACTUALLY RUNS. `StdioTransport` always injects `agent stdio` ahead of
 *    any args, so `{command: node, args: ['-e', '...']}` really spawned
 *    `node agent stdio -e ...` — Node looked for a FILE called `agent`, failed
 *    to find it, and exited. The child never executed the code the test named.
 *    Writing a real file called `agent` into the working directory is what makes
 *    the injected argv run something on purpose.
 *
 * 2. IT STAYS ALIVE. Racing a dying process cannot work: `send()` checks
 *    `stdin.writable` first, and once a child has exited that flag is already
 *    false, so the write never reaches the pipe. Measured, the racing version
 *    proved the control on 1 run in 8. With the child alive, the parent's write
 *    end stays writable while the read end is gone — exactly the kernel
 *    condition for EPIPE, and it does not depend on timing at all.
 */
const AGENT_SRC =
  'require("fs").closeSync(0);\n' +
  'process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"ready"})+"\\n");\n' +
  // Bounded, not immortal: the child must never be able to outlive the test.
  'setTimeout(()=>process.exit(0),10000);\n';

async function agentThatClosedItsStdin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grokrc-epipe-'));
  // Named `agent` because that is the argv the transport injects.
  await writeFile(join(dir, 'agent'), AGENT_SRC);
  return dir;
}

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

  const dir = await agentThatClosedItsStdin();
  const transport = new StdioTransport({ command: process.execPath, cwd: dir });

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
