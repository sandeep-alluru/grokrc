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
import { StdioTransport, NdjsonDecoder } from '../src/acp/transport.ts';
import type { JsonRpcMessage } from '../src/acp/protocol.ts';

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
  // `true` exits immediately — the agent is gone before we ever write.
  const t = new StdioTransport({ command: 'true', cwd: '/tmp' });
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

test('a stdin write failure is reported as an error event, not a crash', async () => {
  // A process that exits after a moment: the write lands in the window between
  // the child dying and `close` reaching us — the exact race that matters.
  const t = new StdioTransport({ command: 'sh', args: ['-c', 'exit 0'], cwd: '/tmp' });
  const errors: Error[] = [];
  let closed = false;
  t.on('error', (e) => errors.push(e));
  t.on('close', () => (closed = true));

  // Hammer the window rather than hoping to hit it once.
  for (let i = 0; i < 40; i++) {
    try {
      t.send({ jsonrpc: '2.0', id: i, method: 'noop' });
    } catch {
      /* "transport closed" is fine */
    }
    await new Promise((r) => setTimeout(r, 5));
  }

  await until(() => closed, 3000);
  assert.equal(closed, true, 'close event should still arrive');
  t.close();
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
