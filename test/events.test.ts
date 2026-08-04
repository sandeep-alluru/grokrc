import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  normalizePermission,
  normalizeSessionUpdate,
  optionIntent,
} from '../src/daemon/events.ts';
import { NdjsonDecoder } from '../src/acp/transport.ts';
import type { JsonRpcMessage } from '../src/acp/protocol.ts';

test('agent_message_chunk becomes a non-final agent text event', () => {
  const [ev] = normalizeSessionUpdate({
    sessionId: 's1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
  });
  assert.deepEqual(ev, { k: 'text', sessionId: 's1', role: 'agent', text: 'hello', final: false });
});

test('tool_call maps ACP status vocabulary onto ours and emits a status event', () => {
  const evs = normalizeSessionUpdate({
    sessionId: 's1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read package.json',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'package.json' },
    },
  });
  assert.equal(evs.length, 2);
  const tool = evs[0]!;
  assert.equal(tool.k, 'tool');
  if (tool.k !== 'tool') throw new Error('unreachable');
  assert.equal(tool.status, 'running');
  assert.equal(tool.toolId, 't1');
  assert.equal(evs[1]!.k, 'status');
});

test('completed and failed map to ok and error', () => {
  const ok = normalizeSessionUpdate({
    sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' },
  })[0]!;
  const bad = normalizeSessionUpdate({
    sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed' },
  })[0]!;
  assert.equal(ok.k === 'tool' && ok.status, 'ok');
  assert.equal(bad.k === 'tool' && bad.status, 'error');
});

test('plan entries are flattened to text/status pairs', () => {
  const [ev] = normalizeSessionUpdate({
    sessionId: 's1',
    update: {
      sessionUpdate: 'plan',
      entries: [
        { content: 'step one', status: 'completed' },
        { content: 'step two', status: 'pending' },
      ],
    },
  });
  assert.equal(ev!.k, 'plan');
  if (ev!.k !== 'plan') throw new Error('unreachable');
  assert.deepEqual(ev.items, [
    { text: 'step one', status: 'completed' },
    { text: 'step two', status: 'pending' },
  ]);
});

test('unknown update kinds pass through as raw instead of being dropped', () => {
  // A future agent release must degrade visibly, never silently lose conversation.
  const [ev] = normalizeSessionUpdate({
    sessionId: 's1',
    update: { sessionUpdate: 'some_future_kind_v9', mystery: 42 },
  });
  assert.equal(ev!.k, 'raw');
  if (ev!.k !== 'raw') throw new Error('unreachable');
  assert.equal(ev.kind, 'some_future_kind_v9');
});

test('option intent prefers structured kind over free-text name', () => {
  assert.equal(optionIntent('allow_once', 'whatever'), 'allow');
  assert.equal(optionIntent('reject_always', 'whatever'), 'deny');
  assert.equal(optionIntent(undefined, 'Approve'), 'allow');
  assert.equal(optionIntent(undefined, 'Cancel'), 'deny');
  assert.equal(optionIntent(undefined, 'Edit first'), 'other');
});

test('permission requests become approval events with classified options', () => {
  const ev = normalizePermission('req-1', {
    sessionId: 's1',
    options: [
      { optionId: 'a', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'r', name: 'Reject', kind: 'reject_once' },
    ],
    toolCall: { toolCallId: 't1', title: 'Run rm -rf build', kind: 'execute', rawInput: { cmd: 'rm -rf build' } },
  });
  assert.equal(ev.k, 'approval');
  if (ev.k !== 'approval') throw new Error('unreachable');
  assert.equal(ev.title, 'Run rm -rf build');
  assert.equal(ev.requestId, 'req-1');
  assert.deepEqual(ev.options.map((o) => o.intent), ['allow', 'deny']);
});

test('permission with no toolCall still yields a usable title', () => {
  const ev = normalizePermission('r', { sessionId: 's', options: [] });
  assert.equal(ev.k === 'approval' && ev.title, 'Permission required');
});

test('NdjsonDecoder reassembles frames split across chunk boundaries', () => {
  // This is the bug that bites every hand-rolled NDJSON reader.
  const dec = new NdjsonDecoder();
  const got: JsonRpcMessage[] = [];
  const collect = (m: JsonRpcMessage) => got.push(m);

  dec.push('{"jsonrpc":"2.0","me', collect);
  assert.equal(got.length, 0, 'must not emit a partial frame');
  dec.push('thod":"a"}\n{"jsonrpc":"2.0","method":"b"}\n', collect);

  assert.equal(got.length, 2);
  assert.equal((got[0] as { method: string }).method, 'a');
  assert.equal((got[1] as { method: string }).method, 'b');
  assert.equal(dec.pending, '');
});

test('NdjsonDecoder reports bad lines without losing the stream', () => {
  const dec = new NdjsonDecoder();
  const got: JsonRpcMessage[] = [];
  const bad: string[] = [];
  dec.push('not json\n{"jsonrpc":"2.0","method":"ok"}\n', (m) => got.push(m), (l) => bad.push(l));
  assert.equal(bad.length, 1);
  assert.equal(got.length, 1);
});
