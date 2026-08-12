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
/**
 * Ceiling on a single unterminated line.
 *
 * ACP frames are legitimately large — a `session/load` replay or a big tool
 * output runs to megabytes — so this is generous. But it must exist: an agent
 * emitting a stream with no newline would otherwise grow the buffer until the
 * process died, and the daemon holds every other session.
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class NdjsonDecoder {
  #buf = '';

  push(
    chunk: string | Buffer,
    onFrame: (msg: JsonRpcMessage) => void,
    onBad?: (line: string, err: Error) => void
  ): void {
    this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    // No newline in sight and past the ceiling: this is not a frame we are ever
    // going to complete. Report and drop, rather than accumulate until the
    // process dies — the daemon holds every other session.
    if (this.#buf.length > MAX_LINE_BYTES && this.#buf.indexOf('\n') === -1) {
      const size = this.#buf.length;
      const head = this.#buf.slice(0, 200);
      this.#buf = '';
      onBad?.(
        head,
        new Error(
          `unterminated ACP line exceeded ${MAX_LINE_BYTES} bytes (${size}) — buffer dropped`
        )
      );
      return;
    }

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
  /**
   * Grok top-level `--permission-mode`. Default `"default"` so remote one-tap
   * approval has a chance. Note: as of Grok 1.0.0, headless `agent stdio` still
   * often auto-resolves tools without emitting `session/request_permission`
   * (see tools/perm-probe.mjs) — this flag is necessary but not sufficient.
   */
  permissionMode?:
    | 'default'
    | 'acceptEdits'
    | 'auto'
    | 'dontAsk'
    | 'bypassPermissions'
    | 'plan'
    | string;
}

export class StdioTransport extends EventEmitter implements Transport {
  #child: ChildProcessWithoutNullStreams;
  #decoder = new NdjsonDecoder();
  #closed = false;
  /** The argv actually used. Exposed so argument-order bugs are testable. */
  readonly args: string[];

  constructor(opts: StdioTransportOptions = {}) {
    super();
    // `--permission-mode` is a top-level `grok` flag (before `agent`).
    // `--leader` and `--leader-socket` belong to `grok agent`, NOT to the
    // `stdio` subcommand — placing them after `stdio` makes grok exit with
    // "unexpected argument". Verified with tools/leader-probe.mjs.
    const args: string[] = [];
    const permissionMode = opts.permissionMode ?? 'default';
    if (permissionMode) {
      args.push('--permission-mode', permissionMode);
    }
    args.push('agent');
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
          this.emit(
            'error',
            new Error(`undecodable ACP frame: ${err.message} :: ${line.slice(0, 200)}`)
          )
      );
    });

    this.#child.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')));

    // stdin needs its own error handler. An unhandled 'error' on a Node stream
    // is THROWN, so an EPIPE — the agent exited in the window between its death
    // and `close` reaching us — would take down the whole daemon, and with it
    // every other session it holds. Report it as a transport error instead.
    this.#child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      this.#closed = true;
      if (err.code === 'EPIPE') {
        this.emit('error', new Error('agent stdin closed (EPIPE) — the process is gone'));
      } else {
        this.emit('error', err);
      }
    });

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
    // `writable` is false the moment the pipe breaks, often before the child's
    // `close` event arrives — check it rather than discovering EPIPE the hard way.
    if (!this.#child.stdin.writable) {
      this.#closed = true;
      throw new Error('transport closed: agent stdin is no longer writable');
    }
    this.#child.stdin.write(JSON.stringify(msg) + '\n');
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    /**
     * Killing a child that never started is not an error worth propagating.
     *
     * `spawn` reports ENOENT asynchronously, so a transport whose agent binary
     * was missing still holds a ChildProcess with no pid. Killing that throws
     * `EINVAL` on Windows (and is a silent no-op on Linux, which is why this
     * went unnoticed). close() is called from shutdown paths and from `catch`
     * blocks, so a throw here replaces the real failure with a confusing one —
     * the same shape as the spawn-ENOENT bug that used to take down the daemon.
     */
    const kill = (signal: 'SIGTERM' | 'SIGKILL') => {
      try {
        this.#child.kill(signal);
      } catch {
        /* never started, or already reaped */
      }
    };
    kill('SIGTERM');
    // Escalate if the agent ignores SIGTERM — otherwise a wedged agent keeps
    // the daemon alive forever on shutdown.
    const t = setTimeout(() => kill('SIGKILL'), 3000);
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
            this.emit(
              'error',
              new Error(`undecodable ACP frame: ${err.message} :: ${line.slice(0, 200)}`)
            )
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
