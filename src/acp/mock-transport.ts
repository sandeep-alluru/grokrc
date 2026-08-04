/**
 * A scripted ACP agent, for tests.
 *
 * Browser and integration tests need realistic agent behaviour without spending
 * tokens or depending on model non-determinism. This replays the shapes we
 * actually captured from `grok 0.2.118` — including a genuine
 * `session/request_permission` with the real three-option payload — so the UI is
 * exercised against true-to-life data every run.
 *
 * Not exported from the package entry point; test-only.
 */
import { EventEmitter } from 'node:events';
import type { JsonRpcMessage } from './protocol.ts';
import type { Transport } from './transport.ts';

export interface MockScriptStep {
  /** ms to wait before emitting, simulating agent latency. */
  delay?: number;
  notify?: { method: string; params: unknown };
  /** Agent→client request (e.g. a permission ask). */
  request?: { method: string; params: unknown };
}

export interface MockTransportOptions {
  /** Emitted in order once `session/prompt` is received. */
  script?: MockScriptStep[];
  sessionId?: string;
}

/**
 * The real permission payload observed end-to-end, verbatim. Widest-first
 * ordering is preserved deliberately — the UI must demote it, and a test that
 * reordered it here would hide the bug it exists to catch.
 */
export const REAL_PERMISSION_PARAMS = {
  sessionId: 'mock-session',
  options: [
    {
      optionId: 'allow-edits-session',
      name: 'Yes, allow all edits during this session',
      kind: 'allow_always',
    },
    { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
  ],
  toolCall: {
    toolCallId: 'tool-1',
    title: 'Write `/tmp/demo/hello.txt`',
    kind: 'edit',
    rawInput: { variant: 'Write', file_path: '/tmp/demo/hello.txt', content: 'grok\n' },
    locations: [{ path: '/tmp/demo/hello.txt' }],
  },
};

/** A turn that streams text, runs a tool, asks permission, then finishes. */
export function defaultScript(sessionId: string): MockScriptStep[] {
  const upd = (update: unknown) => ({
    method: 'session/update',
    params: { sessionId, update },
  });
  return [
    { delay: 10, notify: upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Considering the request…' } }) },
    { delay: 10, notify: upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will create ' } }) },
    { delay: 10, notify: upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello.txt for you.' } }) },
    { delay: 10, notify: upd({ sessionUpdate: 'plan', entries: [
      { content: 'Write hello.txt', status: 'in_progress' },
      { content: 'Confirm contents', status: 'pending' },
    ] }) },
    { delay: 10, notify: upd({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Write `/tmp/demo/hello.txt`', kind: 'edit', status: 'in_progress', rawInput: { file_path: '/tmp/demo/hello.txt' } }) },
    { delay: 20, request: { method: 'session/request_permission', params: { ...REAL_PERMISSION_PARAMS, sessionId } } },
    { delay: 10, notify: upd({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: 'wrote 5 bytes' }) },
    { delay: 10, notify: upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done — created hello.txt.' } }) },
    { delay: 10, notify: upd({ sessionUpdate: 'turn_completed' }) },
  ];
}

export class MockTransport extends EventEmitter implements Transport {
  #closed = false;
  #sessionId: string;
  #script: MockScriptStep[];
  #nextRequestId = 9000;
  /** Resolved when the scripted permission request is answered. */
  permissionAnswers: { optionId: string | null }[] = [];

  constructor(opts: MockTransportOptions = {}) {
    super();
    this.#sessionId = opts.sessionId ?? 'mock-session';
    this.#script = opts.script ?? defaultScript(this.#sessionId);
  }

  send(msg: JsonRpcMessage): void {
    if (this.#closed) return;
    // Reply asynchronously so callers see real async ordering.
    setImmediate(() => void this.#handle(msg));
  }

  async #handle(msg: JsonRpcMessage): Promise<void> {
    const m = msg as { id?: number | string; method?: string; result?: unknown };

    // A response to one of OUR agent→client requests (i.e. a permission answer).
    if (m.id !== undefined && m.method === undefined) {
      const outcome = (m.result as { outcome?: { outcome: string; optionId?: string } })?.outcome;
      this.permissionAnswers.push({
        optionId: outcome?.outcome === 'selected' ? outcome.optionId ?? null : null,
      });
      return;
    }

    switch (m.method) {
      case 'initialize':
        return this.#reply(m.id!, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            sessionCapabilities: { list: {} },
          },
          authMethods: [{ id: 'cached_token', name: 'cached_token' }],
        });

      case 'session/new':
        this.#reply(m.id!, { sessionId: this.#sessionId });
        return;

      case 'session/prompt':
        await this.#runScript();
        this.#reply(m.id!, { stopReason: 'end_turn' });
        return;

      case 'session/cancel':
        return;

      default:
        if (m.id !== undefined) this.#reply(m.id, {});
    }
  }

  async #runScript(): Promise<void> {
    for (const step of this.#script) {
      if (this.#closed) return;
      if (step.delay) await new Promise((r) => setTimeout(r, step.delay));
      if (step.notify) {
        this.#emit({ jsonrpc: '2.0', method: step.notify.method, params: step.notify.params });
      }
      if (step.request) {
        // Block until answered, exactly like the real agent does.
        const id = this.#nextRequestId++;
        const before = this.permissionAnswers.length;
        this.#emit({ jsonrpc: '2.0', id, method: step.request.method, params: step.request.params });
        const deadline = Date.now() + 15_000;
        while (this.permissionAnswers.length === before && Date.now() < deadline && !this.#closed) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    }
  }

  #reply(id: number | string, result: unknown): void {
    this.#emit({ jsonrpc: '2.0', id, result });
  }

  #emit(msg: JsonRpcMessage): void {
    if (!this.#closed) this.emit('message', msg);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('close', { code: 0 });
  }
}
