/**
 * A second prompt while a turn is running must interrupt the first.
 *
 * Phone follow-ups used to be impossible because Send morphed into Stop.
 * Term already sent the new prompt; the daemon must cancel the in-flight turn
 * so two session/prompt RPCs do not race on one conversation.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MockTransport } from '../src/acp/mock-transport.ts';
import { SessionManager } from '../src/daemon/session-manager.ts';

test('a second prompt cancels the in-flight turn and starts a new one', async () => {
  let transport: MockTransport | undefined;
  const sessions = new SessionManager({
    transportFactory: () => {
      transport = new MockTransport({
        sessionId: 'interrupt-1',
        script: [
          // Long enough that a follow-up arrives before end_turn.
          {
            delay: 800,
            notify: {
              method: 'session/update',
              params: {
                sessionId: 'interrupt-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'first turn…' },
                },
              },
            },
          },
        ],
      });
      return transport;
    },
  });

  const info = await sessions.create('/tmp');
  const first = sessions.prompt(info.id, 'first');
  // Let the first prompt actually reach the transport.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(transport!.promptCount, 1, 'first prompt must be in flight');

  await sessions.prompt(info.id, 'follow-up');
  await first.catch(() => undefined);

  assert.ok(transport!.cancelCount >= 1, 'in-flight turn must be cancelled');
  assert.equal(transport!.promptCount, 2, 'follow-up must start a second prompt');
  assert.equal(sessions.get(info.id)?.state, 'done');

  sessions.closeAll();
});

test('late working/thinking ticks after the turn ends are not emitted', async () => {
  // Reproduces the stuck-Stop path: prompt settles → done, then a completed
  // tool_call_update synthesizes thinking. Without the prompting gate that
  // tick re-armed the phone composer.
  let transport: MockTransport | undefined;
  const sessions = new SessionManager({
    transportFactory: () => {
      transport = new MockTransport({
        sessionId: 'late-1',
        script: [
          {
            delay: 20,
            notify: {
              method: 'session/update',
              params: {
                sessionId: 'late-1',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 't1',
                  status: 'completed',
                  title: 'Read file',
                },
              },
            },
          },
        ],
      });
      return transport;
    },
  });

  const seen: string[] = [];
  sessions.on('event', (ev) => {
    if (ev.k === 'status') seen.push(ev.state);
  });

  const info = await sessions.create('/tmp');
  await sessions.prompt(info.id, 'go');
  assert.ok(seen.includes('done'), `expected done in ${JSON.stringify(seen)}`);
  assert.ok(
    seen.includes('thinking') || seen.includes('working'),
    'precondition: an in-turn tool status was observed'
  );

  transport!.pushAgentNotify('session/update', {
    sessionId: 'late-1',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't2',
      status: 'completed',
      title: 'Late update',
    },
  });
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(sessions.get(info.id)?.state, 'done', 'late tick must not reopen the turn');
  const afterDone = seen.slice(seen.lastIndexOf('done') + 1);
  assert.deepEqual(
    afterDone.filter((s) => s === 'thinking' || s === 'working'),
    [],
    `late busy statuses leaked after done: ${JSON.stringify(afterDone)}`
  );

  sessions.closeAll();
});

test('explicit cancel clears busy even if the agent is still winding down', async () => {
  let transport: MockTransport | undefined;
  const sessions = new SessionManager({
    transportFactory: () => {
      transport = new MockTransport({
        sessionId: 'cancel-1',
        script: [{ delay: 2_000 }],
      });
      return transport;
    },
  });

  const info = await sessions.create('/tmp');
  const turn = sessions.prompt(info.id, 'long');
  // Wait until the agent has the prompt — cancelling before that measures
  // nothing about mid-turn Stop.
  const deadline = Date.now() + 2_000;
  while (transport!.promptCount < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(transport!.promptCount, 1, 'precondition: prompt is in flight');
  sessions.cancel(info.id);
  assert.equal(sessions.get(info.id)?.state, 'idle', 'cancel must set idle immediately');
  // cancel is async on the mock transport (setImmediate); give it a tick.
  await new Promise((r) => setImmediate(r));
  assert.equal(transport!.cancelCount, 1, 'session/cancel must reach the agent');
  await turn.catch(() => undefined);
  assert.equal(sessions.get(info.id)?.state, 'idle', 'stale completion must not re-busy');

  sessions.closeAll();
});
