/**
 * A turn stopped mid-flight must not lose the text already seen.
 *
 * Reproduced against a real agent (tools/midturn-check.mjs): it streamed
 * "1..22", was stopped the way Take over stops it, and the resumed history held
 * ZERO characters of agent text.
 *
 * The cause was ours. Streaming text is coalesced in `s.stream` and only
 * reaches `s.log` when the stream ENDS, so closing mid-turn dropped a buffer the
 * user had already watched fill. The README blamed Grok's flushing and claimed
 * resume recovered it; both halves were wrong.
 *
 * The agent here is a double on purpose, and a specific one: its `loadSession`
 * replays NOTHING. That is the whole point — it reproduces an agent that never
 * persisted the interrupted turn, so the only way the text can come back is the
 * control under test. A replaying mock would pass whether or not the control
 * existed, which is exactly what the first version of this test did.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-midturn-'));
process.env.GROKRC_HOME = tmp;
process.env.GROK_HOME = tmp;

const { SessionManager } = await import('../src/daemon/session-manager.ts');

const SESSION_ID = '019fabcd-0000-7000-8000-00000000mid';

/**
 * An agent that streams two text chunks and never finishes the turn, and whose
 * session/load returns an EMPTY history — the shape of a real agent killed
 * before it flushed.
 */
class AmnesiacTransport extends EventEmitter {
  send(msg: any): void {
    const reply = (result: unknown) =>
      queueMicrotask(() => this.emit('message', { jsonrpc: '2.0', id: msg.id, result }));
    const update = (update: unknown) =>
      queueMicrotask(() =>
        this.emit('message', {
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: SESSION_ID, update },
        })
      );

    if (msg.method === 'initialize') {
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    }
    if (msg.method === 'session/new') return reply({ sessionId: SESSION_ID });
    // The interrupted turn is never replayed — that is what "never persisted" means.
    if (msg.method === 'session/load') return reply({});
    if (msg.method === 'session/prompt') {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'PART-ONE ' },
      });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PART-TWO' } });
      return; // never answers: the turn is still in flight when we close
    }
    if (msg.id !== undefined) reply({});
  }
  close(): void {
    this.emit('close', { code: 0 });
  }
}

test('text streamed before a mid-turn close survives the resume', async () => {
  await mkdir(join(tmp, 'sessions', encodeURIComponent(tmp), SESSION_ID), { recursive: true });

  const sessions = new SessionManager({
    transportFactory: () => new AmnesiacTransport() as never,
  });
  try {
    const info = await sessions.create(tmp, { title: 'midturn' });

    const streamed: string[] = [];
    sessions.on('event', (ev: any) => {
      if (ev.k === 'text' && ev.role === 'agent') streamed.push(ev.text);
    });

    void sessions.prompt(info.id, 'count').catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(streamed.join('').includes('PART-ONE'), 'precondition: the turn must be streaming');

    // Stop mid-turn, exactly as Take over does.
    sessions.close(info.id);
    await new Promise((r) => setTimeout(r, 200));

    await sessions.resume(info.id, tmp);
    await new Promise((r) => setTimeout(r, 300));

    const recovered = sessions
      .history(info.id)
      .filter((e: any) => e.k === 'text')
      .map((e: any) => e.text)
      .join('');

    assert.match(
      recovered,
      /PART-ONE/,
      `the interrupted turn's text was lost — the agent replayed nothing and the daemon discarded its own copy. Got: ${JSON.stringify(recovered)}`
    );
    assert.match(recovered, /PART-TWO/, 'the tail of the coalesced buffer was dropped');
  } finally {
    sessions.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
});
