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
        this.emit('event', { k: 'raw', sessionId: '', kind: 'log_truncated', payload: null });
      }
      if (st.size === this.#offset) return;

      const chunk = await this.#read(this.#offset, st.size - 1);
      this.#offset = st.size;
      this.#partial += chunk;

      let nl: number;
      while ((nl = this.#partial.indexOf('\n')) !== -1) {
        const line = this.#partial.slice(0, nl).trim();
        this.#partial = this.#partial.slice(nl + 1);
        if (line) this.#emitLine(line);
      }
    } catch (err) {
      // ENOENT is normal: the session directory can exist before the log does.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.emit('error', err as Error);
      }
    } finally {
      this.#reading = false;
    }
  }

  #read(start: number, end: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = '';
      createReadStream(this.#path, { start, end, encoding: 'utf8' })
        .on('data', (c) => (out += c))
        .on('end', () => resolve(out))
        .on('error', reject);
    });
  }

  #emitLine(line: string): void {
    let parsed: LogLine;
    try {
      parsed = JSON.parse(line) as LogLine;
    } catch {
      return; // a torn final line; the next poll re-reads it whole
    }

    // Both `session/update` and the vendor-prefixed `_x.ai/session/update`
    // appear in real logs and carry the same payload shape.
    if (!parsed.method?.endsWith('session/update') || !parsed.params) return;

    for (const ev of normalizeSessionUpdate(parsed.params)) {
      this.emit('event', ev);
    }
  }
}
