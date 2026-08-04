/**
 * ACP client — speaks Grok Build's agent protocol.
 *
 * The important part is `permission`: when the agent wants to run a tool it
 * sends a `session/request_permission` JSON-RPC *request* and blocks until we
 * answer. We surface that as an event carrying a `respond` callback, so the
 * daemon can forward it to a phone and resolve it whenever the human taps —
 * seconds or minutes later. That deferred answer is the whole reason this
 * project can do one-tap approvals while PTY-based tools regex an ANSI screen.
 */
import { EventEmitter } from 'node:events';
import {
  ACP_PROTOCOL_VERSION,
  isNotification,
  isRequest,
  isResponse,
  type InitializeResult,
  type JsonRpcMessage,
  type NewSessionResult,
  type PermissionOutcome,
  type PromptResult,
  type RequestPermissionParams,
  type SessionUpdateParams,
} from './protocol.ts';
import type { Transport } from './transport.ts';

export interface PermissionRequest {
  sessionId: string;
  params: RequestPermissionParams;
  /** Resolve the agent's blocked request. Safe to call once; later calls no-op. */
  respond(outcome: PermissionOutcome): void;
}

export interface AcpClientOptions {
  transport: Transport;
  /** How long to wait for a response before rejecting. Prompts get their own, longer, budget. */
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  /** Serve `fs/read_text_file` and `fs/write_text_file` on the agent's behalf. */
  fsCapability?: boolean;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
  method: string;
}

export class AcpClient extends EventEmitter {
  #transport: Transport;
  #nextId = 1;
  #pending = new Map<number | string, Pending>();
  #requestTimeoutMs: number;
  #promptTimeoutMs: number;
  #fsCapability: boolean;
  #initialized: InitializeResult | null = null;
  #closed = false;

  constructor(opts: AcpClientOptions) {
    super();
    this.#transport = opts.transport;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    // Agent turns routinely run for many minutes. A 60s timeout here would kill
    // real work, so prompts get an explicitly generous budget.
    this.#promptTimeoutMs = opts.promptTimeoutMs ?? 30 * 60_000;
    this.#fsCapability = opts.fsCapability ?? true;

    this.#transport.on('message', (m) => this.#onMessage(m));
    this.#transport.on('error', (e) => this.emit('error', e));
    this.#transport.on('stderr', (t) => this.emit('stderr', t));
    this.#transport.on('close', (info) => {
      this.#closed = true;
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`agent exited (code ${info.code}) while awaiting ${p.method}`));
        this.#pending.delete(id);
      }
      this.emit('close', info);
    });
  }

  get initialized(): InitializeResult | null {
    return this.#initialized;
  }

  get capabilities(): InitializeResult['agentCapabilities'] | undefined {
    return this.#initialized?.agentCapabilities;
  }

  /* ─── outbound ────────────────────────────────────────────────────────── */

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('client closed'));
    const id = this.#nextId++;
    this.#transport.send({ jsonrpc: '2.0', id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`ACP timeout after ${timeoutMs ?? this.#requestTimeoutMs}ms: ${method}`));
      }, timeoutMs ?? this.#requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#transport.send({ jsonrpc: '2.0', method, params });
  }

  /* ─── lifecycle ───────────────────────────────────────────────────────── */

  async initialize(): Promise<InitializeResult> {
    const result = await this.request<InitializeResult>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: this.#fsCapability, writeTextFile: this.#fsCapability },
      },
    });
    this.#initialized = result;

    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      // Loud, not fatal: the agent may still be compatible, but silent drift is
      // exactly how a screen-scraper-grade bug gets into a protocol client.
      this.emit(
        'protocol-drift',
        new Error(
          `ACP protocolVersion ${result.protocolVersion}, expected ${ACP_PROTOCOL_VERSION}. ` +
            `Re-run tools/acp-probe.mjs and update src/acp/protocol.ts.`
        )
      );
    }
    return result;
  }

  /** Only needed when the agent reports no usable cached credential. */
  async authenticate(methodId: string): Promise<void> {
    await this.request('authenticate', { methodId });
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<NewSessionResult> {
    return this.request<NewSessionResult>('session/new', { cwd, mcpServers });
  }

  async loadSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<unknown> {
    if (!this.capabilities?.loadSession) {
      throw new Error('agent does not advertise loadSession capability');
    }
    return this.request('session/load', { sessionId, cwd, mcpServers });
  }

  async listSessions(): Promise<unknown> {
    return this.request('session/list', {});
  }

  /** Runs a full agent turn. Resolves with a stopReason when the turn ends. */
  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    return this.request<PromptResult>(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text }] },
      this.#promptTimeoutMs
    );
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request('session/set_mode', { sessionId, modeId });
  }

  close(): void {
    this.#closed = true;
    this.#transport.close();
  }

  /* ─── inbound ─────────────────────────────────────────────────────────── */

  #onMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const p = this.#pending.get(msg.id);
      if (!p) return; // late response to something already timed out
      clearTimeout(p.timer);
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
      return;
    }

    if (isRequest(msg)) {
      void this.#onAgentRequest(msg.id, msg.method, msg.params);
      return;
    }

    if (isNotification(msg)) {
      if (msg.method === 'session/update') {
        this.emit('session-update', msg.params as SessionUpdateParams);
      }
      // Vendor extensions (_x.ai/models/update, _x.ai/session_notification, ...)
      // are forwarded verbatim rather than dropped — they carry model changes
      // and hook execution that the UI wants, and modelling them would couple us
      // to xAI's internals.
      this.emit('notification', msg.method, msg.params);
      return;
    }
  }

  async #onAgentRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const reply = (result: unknown) =>
      this.#transport.send({ jsonrpc: '2.0', id, result } as JsonRpcMessage);
    const fail = (code: number, message: string) =>
      this.#transport.send({ jsonrpc: '2.0', id, error: { code, message } } as JsonRpcMessage);

    switch (method) {
      case 'session/request_permission': {
        const p = params as RequestPermissionParams;
        let answered = false;
        const req: PermissionRequest = {
          sessionId: p.sessionId,
          params: p,
          respond: (outcome) => {
            if (answered) return;
            answered = true;
            reply({ outcome });
          },
        };
        // No listener means nothing can approve — deny rather than hang the agent.
        if (this.listenerCount('permission') === 0) {
          req.respond({ outcome: 'cancelled' });
          return;
        }
        this.emit('permission', req);
        return;
      }

      case 'fs/read_text_file': {
        if (!this.#fsCapability) return fail(-32601, 'fs capability disabled');
        try {
          const { readFile } = await import('node:fs/promises');
          const { path, line, limit } = params as { path: string; line?: number; limit?: number };
          let content = await readFile(path, 'utf8');
          if (line !== undefined || limit !== undefined) {
            const lines = content.split('\n');
            const start = Math.max(0, (line ?? 1) - 1);
            content = lines
              .slice(start, limit !== undefined ? start + limit : undefined)
              .join('\n');
          }
          reply({ content });
        } catch (err) {
          fail(-32000, (err as Error).message);
        }
        return;
      }

      case 'fs/write_text_file': {
        if (!this.#fsCapability) return fail(-32601, 'fs capability disabled');
        try {
          const { writeFile, mkdir } = await import('node:fs/promises');
          const { dirname } = await import('node:path');
          const { path, content } = params as { path: string; content: string };
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content, 'utf8');
          reply(null);
        } catch (err) {
          fail(-32000, (err as Error).message);
        }
        return;
      }

      default:
        // Unknown agent→client request. Answering {} keeps the turn alive; the
        // alternative is a wedged agent waiting on a method we never implemented.
        this.emit('unhandled-request', method, params);
        reply({});
    }
  }
}
