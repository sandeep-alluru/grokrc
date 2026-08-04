/**
 * ACP transports. The protocol is identical across all of them — only the pipe
 * differs — so the client is written once against this interface.
 *
 * Grok Build offers four:
 *   grok agent stdio     → StdioTransport            (implemented)
 *   grok agent serve     → WebSocketTransport        (implemented)
 *   grok agent leader    → StdioTransport + --leader (shared backend)
 *   grok agent headless  → outbound relay dial       (see relay/, not yet wired)
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { JsonRpcMessage } from './protocol.ts';

export interface Transport extends EventEmitter {
  /** Emitted per decoded JSON-RPC frame. */
  on(event: 'message', cb: (msg: JsonRpcMessage) => void): this;
  /** Transport-level failure. Not a protocol error. */
  on(event: 'error', cb: (err: Error) => void): this;
  /** Pipe closed. */
  on(event: 'close', cb: (info: { code: number | null; reason?: string }) => void): this;
  /** Diagnostic text (agent stderr). Never protocol data. */
  on(event: 'stderr', cb: (text: string) => void): this;

  send(msg: JsonRpcMessage): void;
  close(): void;
}

/**
 * Splits a byte stream into newline-delimited JSON frames.
 *
 * Kept separate from the transports so it can be unit-tested against recorded
 * captures, and because chunk boundaries land mid-frame constantly in practice —
 * that is the bug that bites every hand-rolled NDJSON reader.
 */
export class NdjsonDecoder {
  #buf = '';

  push(chunk: string | Buffer, onFrame: (msg: JsonRpcMessage) => void, onBad?: (line: string, err: Error) => void): void {
    this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      try {
        onFrame(JSON.parse(line) as JsonRpcMessage);
      } catch (err) {
        onBad?.(line, err as Error);
      }
    }
  }

  /** Bytes buffered but not yet terminated by a newline. */
  get pending(): string {
    return this.#buf;
  }
}

export interface StdioTransportOptions {
  /** Path to the grok binary. */
  command?: string;
  /** Extra args appended after `agent stdio`. */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Share one backend with an already-running leader process. */
  useLeader?: boolean;
  /** Custom leader socket path (default `~/.grok/leader.sock`). */
  leaderSocket?: string;
  /** Model override, e.g. `grok-build`. */
  model?: string;
}

export class StdioTransport extends EventEmitter implements Transport {
  #child: ChildProcessWithoutNullStreams;
  #decoder = new NdjsonDecoder();
  #closed = false;
  /** The argv actually used. Exposed so argument-order bugs are testable. */
  readonly args: string[];

  constructor(opts: StdioTransportOptions = {}) {
    super();
    // `--leader` and `--leader-socket` belong to `grok agent`, NOT to the
    // `stdio` subcommand — placing them after `stdio` makes grok exit with
    // "unexpected argument". Verified with tools/leader-probe.mjs.
    const args = ['agent'];
    if (opts.useLeader) args.push('--leader');
    if (opts.leaderSocket) args.push('--leader-socket', opts.leaderSocket);
    args.push('stdio');
    if (opts.model) args.push('--model', opts.model);
    if (opts.args?.length) args.push(...opts.args);
    this.args = args;

    this.#child = spawn(opts.command ?? 'grok', args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.#child.stdout.on('data', (chunk: Buffer) => {
      this.#decoder.push(
        chunk,
        (msg) => this.emit('message', msg),
        (line, err) =>
          this.emit('error', new Error(`undecodable ACP frame: ${err.message} :: ${line.slice(0, 200)}`))
      );
    });

    this.#child.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')));

    this.#child.on('error', (err) => this.emit('error', err));
    this.#child.on('close', (code) => {
      this.#closed = true;
      this.emit('close', { code });
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  send(msg: JsonRpcMessage): void {
    if (this.#closed) throw new Error('transport closed');
    this.#child.stdin.write(JSON.stringify(msg) + '\n');
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.kill('SIGTERM');
    // Escalate if the agent ignores SIGTERM — otherwise a wedged agent keeps
    // the daemon alive forever on shutdown.
    const t = setTimeout(() => this.#child.kill('SIGKILL'), 3000);
    t.unref?.();
  }
}

export interface WebSocketTransportOptions {
  url: string;
  /** Matches `grok agent serve --secret`. */
  secret?: string;
  headers?: Record<string, string>;
}

/**
 * Talks to `grok agent serve` (default 127.0.0.1:2419).
 *
 * `ws` is imported lazily so the stdio path — the common case — has no runtime
 * dependency at all.
 */
export class WebSocketTransport extends EventEmitter implements Transport {
  #ws: import('ws').WebSocket | null = null;
  #queue: JsonRpcMessage[] = [];
  #closed = false;

  constructor(opts: WebSocketTransportOptions) {
    super();
    void this.#connect(opts);
  }

  async #connect(opts: WebSocketTransportOptions): Promise<void> {
    try {
      const { WebSocket } = await import('ws');
      const headers = { ...opts.headers };
      if (opts.secret) headers['Authorization'] = `Bearer ${opts.secret}`;
      const ws = new WebSocket(opts.url, { headers });
      this.#ws = ws;

      ws.on('open', () => {
        for (const m of this.#queue.splice(0)) ws.send(JSON.stringify(m) + '\n');
      });
      const decoder = new NdjsonDecoder();
      ws.on('message', (data: Buffer | string) => {
        decoder.push(
          typeof data === 'string' ? data : data.toString('utf8'),
          (msg) => this.emit('message', msg),
          (line, err) =>
            this.emit('error', new Error(`undecodable ACP frame: ${err.message} :: ${line.slice(0, 200)}`))
        );
      });
      ws.on('error', (err: Error) => this.emit('error', err));
      ws.on('close', (code: number, reason: Buffer) => {
        this.#closed = true;
        this.emit('close', { code, reason: reason?.toString() });
      });
    } catch (err) {
      this.emit('error', err as Error);
    }
  }

  send(msg: JsonRpcMessage): void {
    if (this.#closed) throw new Error('transport closed');
    if (this.#ws && this.#ws.readyState === 1) this.#ws.send(JSON.stringify(msg) + '\n');
    else this.#queue.push(msg);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ws?.close();
  }
}
