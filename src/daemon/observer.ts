/**
 * Observed mode — mirror a session the user started by hand in their terminal.
 *
 * Grok persists every ACP session update to
 * `~/.grok/sessions/<url-encoded-cwd>/<id>/updates.jsonl`, one JSON-RPC frame
 * per line:
 *
 *     {"timestamp":1784608973,"method":"session/update","params":{...}}
 *
 * `params` is byte-identical to what the live protocol sends, so the same
 * normalizer handles both. That means a TUI session running in another window
 * shows up on the phone with no cooperation from that process — which is the
 * point: installing grokrc must not change how you already work.
 *
 * Read-only by construction. There is no way to inject a prompt or answer an
 * approval through a log file, and pretending otherwise would be a lie the UI
 * would have to tell.
 */
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeSessionUpdate, type RcEvent } from './events.ts';
import type { SessionUpdateParams } from '../acp/protocol.ts';

/**
 * fs.watch is unreliable across platforms and filesystems (and silently dead on
 * some network mounts), so we poll size. An appended log is cheap to stat.
 */
const POLL_MS = 500;

interface LogLine {
  timestamp?: number;
  method?: string;
  params?: SessionUpdateParams;
}

export interface ObserverOptions {
  sessionDir: string;
  pollMs?: number;
}

export class SessionObserver extends EventEmitter {
  #path: string;
  #offset = 0;
  #partial = '';
  /** Persists across polls so a multi-byte character split by a read boundary
   *  is completed rather than mangled. */
  #decoder = new StringDecoder('utf8');
  #timer: NodeJS.Timeout | null = null;
  #reading = false;
  #pollMs: number;
  #stopped = false;

  constructor(opts: ObserverOptions) {
    super();
    this.#path = join(opts.sessionDir, 'updates.jsonl');
    this.#pollMs = opts.pollMs ?? POLL_MS;
  }

  override on(event: 'event', cb: (e: RcEvent) => void): this;
  /** Emitted when the log tail is reached — flush any accumulated stream. */
  override on(event: 'idle', cb: () => void): this;
  override on(event: 'error', cb: (e: Error) => void): this;
  override on(event: string, cb: (...a: any[]) => void): this {
    return super.on(event, cb);
  }

  /** Replay everything already written, then follow appends. */
  async start(): Promise<void> {
    await this.#drain();
    this.#timer = setInterval(() => void this.#drain(), this.#pollMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Read everything appended since the last pass. */
  async #drain(): Promise<void> {
    if (this.#reading || this.#stopped) return;
    this.#reading = true;
    try {
      const st = await stat(this.#path);

      if (st.size < this.#offset) {
        // File shrank — session was rewound or restarted. Start over rather than
        // reading from a stale offset into the middle of a line.
        this.#offset = 0;
        this.#partial = '';
        // A fresh decoder too: any half-character it was holding belongs to the
        // file that no longer exists, and would corrupt the first line of the new one.
        this.#decoder = new StringDecoder('utf8');
        this.emit('event', { k: 'raw', sessionId: '', kind: 'log_truncated', payload: null });
      }
      if (st.size === this.#offset) return;

      const bytes = await this.#read(this.#offset, st.size - 1);
      this.#offset = st.size;
      // The decoder carries any incomplete UTF-8 sequence to the next pass.
      this.#partial += this.#decoder.write(bytes);

      let emitted = false;
      let nl: number;
      while ((nl = this.#partial.indexOf('\n')) !== -1) {
        const line = this.#partial.slice(0, nl).trim();
        this.#partial = this.#partial.slice(nl + 1);
        if (line) {
          this.#emitLine(line);
          emitted = true;
        }
      }

      // Signal that the log tail has been reached. A log that ends mid-stream —
      // the common case, since the last thing written is usually the agent's
      // final message — leaves accumulated chunks with nothing to flush them.
      // Without this the last reply vanished from replayed history.
      if (emitted) this.emit('idle');
    } catch (err) {
      // ENOENT is normal: the session directory can exist before the log does.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.emit('error', err as Error);
      }
    } finally {
      this.#reading = false;
    }
  }

  /**
   * Read a byte range as RAW bytes.
   *
   * Deliberately no `encoding` option. We poll at byte offsets against a file
   * a live agent is still appending to, so a read boundary lands inside a
   * multi-byte character routinely. Decoding each range independently turned
   * every em-dash, arrow and emoji that straddled a boundary into replacement
   * characters — `done — created` became `done ??? created`. Decoding is done
   * by a persistent StringDecoder instead, which holds the incomplete tail of a
   * sequence until the bytes that finish it arrive.
   */
  #read(start: number, end: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      createReadStream(this.#path, { start, end })
        .on('data', (c) => chunks.push(c as Buffer))
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject);
    });
  }

  #emitLine(line: string): void {
    let parsed: LogLine;
    try {
      parsed = JSON.parse(line) as LogLine;
    } catch {
      // NOT a torn line — only complete newline-terminated lines reach here, and
      // this one has already been consumed from #partial with the offset moved
      // past it, so it will never be seen again. This is genuinely malformed
      // JSON. Dropping one line beats aborting the tail of a live session.
      return;
    }

    // Both `session/update` and the vendor-prefixed `_x.ai/session/update`
    // appear in real logs and carry the same payload shape.
    if (!parsed.method?.endsWith('session/update') || !parsed.params) return;

    for (const ev of normalizeSessionUpdate(parsed.params)) {
      this.emit('event', ev);
    }
  }
}
