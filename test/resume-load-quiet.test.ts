/**
 * Resume / take-over must not flood live clients during session/load.
 *
 * Observed mode already suppresses catch-up broadcasts. Owned resume used to
 * re-emit every loadSession token as a live WebSocket event while the phone was
 * already watching — enough to blank Mobile Safari on a long conversation.
 * Take over is the main path that hits this: open (observe) → take over (load).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-resume-quiet-'));
process.env.GROKRC_HOME = tmp;
process.env.GROK_HOME = tmp;

const { SessionManager } = await import('../src/daemon/session-manager.ts');

const SESSION_ID = '019fabcd-0000-7000-8000-00000000lod';

/** Agent whose loadSession replays many history chunks, then goes quiet. */
class LoadyTransport extends EventEmitter {
  send(msg: any): void {
    const reply = (result: unknown) =>
      queueMicrotask(() => this.emit('message', { jsonrpc: '2.0', id: msg.id, result }));
    const update = (update: unknown) =>
      this.emit('message', {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: SESSION_ID, update },
      });

    if (msg.method === 'initialize') {
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    }
    if (msg.method === 'session/new') return reply({ sessionId: SESSION_ID });
    if (msg.method === 'session/load') {
      // Synchronous flood — same shape as a real agent dumping history before
      // answering the load RPC. Hundreds of tokens is routine for a long session.
      for (let i = 0; i < 200; i++) {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `tok${i} ` },
        });
      }
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'DONE' },
      });
      return reply({});
    }
    if (msg.method === 'session/prompt') {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'live-reply' },
      });
      return reply({ stopReason: 'end_turn' });
    }
    if (msg.id !== undefined) reply({});
  }
  close(): void {
    this.emit('close', { code: 0 });
  }
}

test('session/load does not emit live events; a later prompt still does', async () => {
  await mkdir(join(tmp, 'sessions', encodeURIComponent(tmp), SESSION_ID), { recursive: true });

  const sessions = new SessionManager({
    transportFactory: () => new LoadyTransport() as never,
  });
  try {
    const live: any[] = [];
    sessions.on('event', (ev) => live.push(ev));

    await sessions.resume(SESSION_ID, tmp);

    const duringLoad = live.length;
    assert.equal(
      duringLoad,
      0,
      `loadSession must not fan out live events (got ${duringLoad}) — this is the phone-blanking flood`
    );

    const hist = sessions.history(SESSION_ID);
    const text = hist
      .filter((e: any) => e.k === 'text' && e.role === 'agent')
      .map((e: any) => e.text)
      .join('');
    assert.match(text, /DONE/, 'history must still hold the loaded transcript');
    assert.match(text, /tok0/, 'coalesced load chunks must land in the log');

    await sessions.prompt(SESSION_ID, 'hi');
    assert.ok(
      live.some((e) => e.k === 'text' && String(e.text).includes('live-reply')),
      'after load, live prompts must still stream to watchers'
    );
  } finally {
    sessions.closeAll();
    await rm(tmp, { recursive: true, force: true });
  }
});
