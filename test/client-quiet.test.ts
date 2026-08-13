/**
 * The phone must not drown in Grok metadata the interactive TUI never paints.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { shouldSendToClient, compactForClient, type RcEvent } from '../src/daemon/events.ts';

test('commands, mode, and raw vendor kinds stay off the wire', () => {
  assert.equal(shouldSendToClient({ k: 'commands', sessionId: 's', commands: [] }), false);
  assert.equal(shouldSendToClient({ k: 'mode', sessionId: 's', modeId: 'default' }), false);
  assert.equal(
    shouldSendToClient({ k: 'raw', sessionId: 's', kind: 'pending_interaction', payload: {} }),
    false
  );
  assert.equal(
    shouldSendToClient({ k: 'raw', sessionId: 's', kind: 'hook_execution', payload: {} }),
    false
  );
});

test('only finished thinking is client-visible', () => {
  assert.equal(
    shouldSendToClient({ k: 'thinking', sessionId: 's', text: 'tok', final: false }),
    false
  );
  assert.equal(
    shouldSendToClient({ k: 'thinking', sessionId: 's', text: 'done', final: true }),
    true
  );
});

test('user text, tools, approvals, status, errors still ship', () => {
  const keep: RcEvent[] = [
    { k: 'text', sessionId: 's', role: 'user', text: 'hi', final: true },
    { k: 'text', sessionId: 's', role: 'agent', text: 'yo', final: true },
    {
      k: 'tool',
      sessionId: 's',
      toolId: 't1',
      name: 'write',
      status: 'ok',
      title: 'Write hello.txt',
    },
    {
      k: 'approval',
      sessionId: 's',
      requestId: 'r1',
      title: 'Allow write?',
      options: [],
    },
    { k: 'status', sessionId: 's', state: 'working' },
    { k: 'error', sessionId: 's', message: 'boom', fatal: false },
  ];
  for (const ev of keep) {
    assert.equal(shouldSendToClient(ev), true, `expected to keep ${ev.k}`);
  }
});

test('tool events lose I/O bodies before the wire', () => {
  const compact = compactForClient({
    k: 'tool',
    sessionId: 's',
    toolId: 't1',
    name: 'write',
    status: 'ok',
    title: 'Write hello.txt',
    input: { content: 'x'.repeat(50_000) },
    output: { stdout: 'y'.repeat(50_000) },
    locations: [{ path: '/tmp/hello.txt' }],
  });
  assert.equal(compact.k, 'tool');
  if (compact.k === 'tool') {
    assert.equal(compact.input, undefined);
    assert.equal(compact.output, undefined);
    assert.equal(compact.title, 'Write hello.txt');
    assert.deepEqual(compact.locations, [{ path: '/tmp/hello.txt' }]);
  }
});
