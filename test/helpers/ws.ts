/**
 * Read websocket frames without racing them, and without counting them.
 *
 * Two separate defects lived here, and both showed up only on CI:
 *
 *  1. COUNTING. Three test files had their own `next(sock)` — take the very
 *     next message and assume it is yours. The daemon broadcasts `sessions`
 *     whenever the list changes, so frame order after `hello` is not fixed.
 *     Locally the extra broadcast landed outside the window; on CI it did not.
 *
 *  2. RACING. Attaching the listener AFTER `send()` loses any reply that
 *     arrives first — an EventEmitter drops an event with no listener, it does
 *     not queue it. With no agent installed the daemon answers faster, so the
 *     reply beat the listener and the test reported `frames seen: []`. Zero
 *     frames, not the wrong frame: the distinction is what identified this.
 *
 * `watch(sock)` fixes both. Call it as soon as the socket is open — BEFORE
 * sending anything — and every frame from that instant is buffered. Then match
 * on content instead of position.
 */
export interface MessageSocket {
  on(event: 'message', cb: (data: unknown) => void): unknown;
  off(event: 'message', cb: (data: unknown) => void): unknown;
}

export interface FrameWatcher<T> {
  /** First buffered-or-future frame satisfying `match`. */
  waitFor(match: (msg: T) => boolean, timeoutMs?: number): Promise<T>;
  /** The common case: first frame of a given `t`. */
  forType(type: string, timeoutMs?: number): Promise<T>;
  /** Everything seen so far — useful in assertion messages. */
  seen(): T[];
  /** Stop buffering. */
  stop(): void;
}

/**
 * Start buffering frames immediately.
 *
 * Attach before you send. Anything that arrives while your test is still
 * setting up is kept, not dropped.
 */
export function watch<T = Record<string, unknown>>(sock: MessageSocket): FrameWatcher<T> {
  const buffer: T[] = [];
  const waiters: { match: (m: T) => boolean; resolve: (m: T) => void }[] = [];

  const onMessage = (data: unknown) => {
    let msg: T;
    try {
      msg = JSON.parse(String(data)) as T;
    } catch {
      return; // sealed or partial frame — not ours to read
    }
    buffer.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.match(msg)) {
        waiters.splice(i, 1)[0]!.resolve(msg);
      }
    }
  };
  sock.on('message', onMessage);

  const waitForFn = (match: (msg: T) => boolean, timeoutMs = 10_000): Promise<T> => {
    // Buffered frames count: the reply may already have arrived.
    const already = buffer.find(match);
    if (already) return Promise.resolve(already);

    return new Promise<T>((resolve, reject) => {
      const entry = {
        match,
        resolve: (m: T) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i !== -1) waiters.splice(i, 1);
        const types = buffer.map((m) => String((m as { t?: unknown }).t ?? '?'));
        reject(new Error(`timed out after ${timeoutMs}ms; frames seen: [${types.join(', ')}]`));
      }, timeoutMs);
      waiters.push(entry);
    });
  };

  return {
    waitFor: waitForFn,
    forType: (type, timeoutMs) => waitForFn((m) => (m as { t?: unknown }).t === type, timeoutMs),
    seen: () => [...buffer],
    stop: () => sock.off('message', onMessage),
  };
}

/**
 * One-shot convenience for sockets already being watched elsewhere.
 *
 * Prefer `watch()`: this still attaches its listener at call time and so cannot
 * see anything that arrived earlier.
 */
export function waitFor<T = Record<string, unknown>>(
  sock: MessageSocket,
  match: (msg: T) => boolean,
  timeoutMs = 10_000
): Promise<T> {
  return watch<T>(sock).waitFor(match, timeoutMs);
}

export function waitForType<T = Record<string, unknown>>(
  sock: MessageSocket,
  type: string,
  timeoutMs = 10_000
): Promise<T> {
  return waitFor<T>(sock, (m) => (m as { t?: unknown }).t === type, timeoutMs);
}
