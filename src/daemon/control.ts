/**
 * Control socket — a local channel from the `grokrc` CLI to the running daemon.
 *
 * Some state only exists inside the daemon process. A pairing code is the clear
 * case: `beginPairing()` writes it to memory, and `redeem()` reads it from the
 * same memory. A separate `grokrc pair` process cannot mint a code the daemon
 * would recognise, which is why it used to tell you to restart with `--pair` —
 * dropping every live session to hand out six characters.
 *
 * This is a Unix domain socket rather than an HTTP route because the HTTP server
 * may be bound to 0.0.0.0 (`--lan`). An unauthenticated "issue me a pairing code"
 * endpoint reachable from the network would hand anyone on the Wi-Fi a way in.
 * A Unix socket has no network presence at all: access is filesystem permissions,
 * and anyone who can open the file already has the user's shell.
 *
 * Wire format is NDJSON in both directions — one JSON object per line:
 *
 *   -> {"id":1,"cmd":"pair"}
 *   <- {"id":1,"ok":true,"result":{"code":"7K44NP","expiresAt":1785...}}
 */
import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { CONFIG_DIR } from './auth.ts';

/**
 * Windows has no Unix domain sockets, and `net` will not bind a filesystem path
 * there — an IPC endpoint must be a named pipe, `\\.\pipe\<name>`.
 *
 * The name is derived from CONFIG_DIR, which contains the user profile path, so
 * two accounts on one machine get different pipes instead of fighting over one.
 *
 * SECURITY, stated plainly because it differs by platform: on Unix the socket is
 * a file in the user's own directory, chmod 0600 — access is filesystem
 * permissions, and anyone who can open it already has the user's shell. Windows
 * named pipes are machine-global and Node exposes no way to set an ACL on them,
 * so the name is unguessable rather than protected. That is weaker. It is
 * recorded in SECURITY.md rather than papered over.
 */
export const IS_WINDOWS = process.platform === 'win32';

export const CONTROL_SOCKET_PATH = IS_WINDOWS
  ? `\\\\.\\pipe\\grokrc-${createHash('sha256').update(CONFIG_DIR).digest('hex').slice(0, 16)}`
  : join(CONFIG_DIR, 'control.sock');

/** How long a CLI call waits before giving up on the daemon. */
const CLIENT_TIMEOUT_MS = 5_000;

/** A control line is tiny; anything larger is a bug or an attack. */
const MAX_LINE_BYTES = 64 * 1024;

export interface ControlRequest {
  id: number;
  cmd: string;
  params?: Record<string, unknown>;
}

export interface ControlResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Everything the control commands are allowed to touch. */
export interface ControlHandlers {
  pair(): { code: string; expiresAt: number };
  devices(): Array<{
    id: string;
    name: string;
    pairedAt: number;
    lastSeen: number;
    connected: boolean;
  }>;
  revoke(deviceId: string): Promise<boolean>;
  revokeAll(): Promise<number>;
  status(): Record<string, unknown>;
  reload(): Promise<{ applied: string[]; needsRestart: string[] }>;
}

/**
 * Thrown when no daemon is listening. Callers use this to fall back to
 * on-disk behaviour rather than reporting a failure.
 */
export class ControlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlUnavailableError';
  }
}

/* ─── server ──────────────────────────────────────────────────────────────── */

export class ControlServer {
  #server: Server | null = null;
  #handlers: ControlHandlers;
  #path: string;
  #sockets = new Set<Socket>();

  constructor(handlers: ControlHandlers, path: string = CONTROL_SOCKET_PATH) {
    this.#handlers = handlers;
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  async listen(): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    // A named pipe is not a file: it has no stale remnant to clear, and it
    // disappears with the process that created it.
    if (!IS_WINDOWS) await this.#clearStaleSocket();

    const server = createServer((sock) => this.#onConnection(sock));
    this.#server = server;

    await new Promise<void>((res, rej) => {
      /**
       * EADDRINUSE here always means a live daemon, and it is the one thing the
       * user needs told.
       *
       * On Unix `#clearStaleSocket()` above has already removed a socket file
       * left by a crashed daemon, so anything still holding the address is
       * running. On Windows there is no file to go stale — a named pipe
       * disappears with the process that created it — so the name being taken
       * means the same thing, with less ambiguity.
       *
       * Without this the Windows path reported the raw errno. `cli.ts` prints
       * it as `⚠ control socket unavailable: listen EADDRINUSE ... \\.\pipe\
       * grokrc-8f2e5c6…`, which names neither the cause nor the fix, for the
       * most likely mistake there is: starting a second `grokrc up`.
       */
      const onError = (err: NodeJS.ErrnoException) =>
        rej(
          err.code === 'EADDRINUSE'
            ? new Error(
                `another grokrc daemon is already running (control endpoint ${this.#path} is in use)`
              )
            : err
        );
      server.once('error', onError);
      server.listen(this.#path, () => {
        server.removeListener('error', onError);
        res();
      });
    });

    // Owner-only. Do this before announcing readiness — between listen() and
    // chmod the socket carries the process umask, which may be world-writable.
    // There is no path to chmod on Windows; see the note on CONTROL_SOCKET_PATH.
    if (!IS_WINDOWS) await chmod(this.#path, 0o600);

    // A dead socket file makes the next daemon think one is already running.
    server.on('error', () => {
      /* a control-channel fault must never take down the daemon */
    });
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((res) => server.close(() => res()));
    await unlink(this.#path).catch(() => {});
  }

  /**
   * A socket file left behind by a crashed daemon would block bind() forever.
   * Distinguish that from a live daemon by trying to connect: refused means
   * nobody is home and the file is safe to remove.
   */
  async #clearStaleSocket(): Promise<void> {
    try {
      await stat(this.#path);
    } catch {
      return; // nothing there
    }

    const alive = await new Promise<boolean>((res) => {
      const probe = createConnection(this.#path);
      const done = (v: boolean) => {
        probe.destroy();
        res(v);
      };
      probe.once('connect', () => done(true));
      probe.once('error', () => done(false));
      probe.setTimeout(1_000, () => done(false));
    });

    if (alive) {
      throw new Error(
        `another grokrc daemon is already running (control socket ${this.#path} is live)`
      );
    }
    await unlink(this.#path).catch(() => {});
  }

  #onConnection(sock: Socket): void {
    this.#sockets.add(sock);
    sock.on('close', () => this.#sockets.delete(sock));
    sock.on('error', () => sock.destroy());

    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) {
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) void this.#dispatch(sock, line);
      }
    });
  }

  async #dispatch(sock: Socket, line: string): Promise<void> {
    let req: ControlRequest;
    try {
      req = JSON.parse(line) as ControlRequest;
    } catch {
      return this.#reply(sock, { id: 0, ok: false, error: 'malformed request' });
    }
    if (typeof req?.cmd !== 'string' || typeof req?.id !== 'number') {
      return this.#reply(sock, { id: 0, ok: false, error: 'malformed request' });
    }

    try {
      const result = await this.#run(req);
      this.#reply(sock, { id: req.id, ok: true, result });
    } catch (err) {
      this.#reply(sock, { id: req.id, ok: false, error: (err as Error).message });
    }
  }

  async #run(req: ControlRequest): Promise<unknown> {
    switch (req.cmd) {
      case 'ping':
        return { pong: true };

      case 'pair':
        return this.#handlers.pair();

      case 'devices':
        return { devices: this.#handlers.devices() };

      case 'revoke': {
        if (req.params?.all === true) {
          return { revoked: await this.#handlers.revokeAll() };
        }
        const id = req.params?.deviceId;
        if (typeof id !== 'string' || !id) throw new Error('deviceId required');
        return { revoked: (await this.#handlers.revoke(id)) ? 1 : 0 };
      }

      case 'status':
        return this.#handlers.status();

      case 'reload':
        return this.#handlers.reload();

      default:
        throw new Error(`unknown command: ${req.cmd}`);
    }
  }

  #reply(sock: Socket, res: ControlResponse): void {
    if (sock.destroyed) return;
    sock.write(JSON.stringify(res) + '\n');
  }
}

/* ─── client ──────────────────────────────────────────────────────────────── */

/**
 * Send one command to a running daemon.
 *
 * Throws {@link ControlUnavailableError} when nothing is listening, so callers
 * can fall back to reading the store off disk instead of reporting an error.
 */
export async function controlRequest<T = unknown>(
  cmd: string,
  params?: Record<string, unknown>,
  path: string = CONTROL_SOCKET_PATH
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const sock = createConnection(path);
    let buf = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };

    const timer = setTimeout(
      () =>
        finish(() => reject(new Error(`control socket timed out after ${CLIENT_TIMEOUT_MS}ms`))),
      CLIENT_TIMEOUT_MS
    );

    sock.setEncoding('utf8');

    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, cmd, params }) + '\n'));

    sock.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      let res: ControlResponse;
      try {
        res = JSON.parse(buf.slice(0, nl)) as ControlResponse;
      } catch {
        return finish(() => reject(new Error('malformed response from daemon')));
      }
      finish(() =>
        res.ok ? resolve(res.result as T) : reject(new Error(res.error ?? 'daemon refused'))
      );
    });

    sock.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT: no socket file. ECONNREFUSED: stale file, daemon gone.
      const gone = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
      finish(() =>
        reject(
          gone
            ? new ControlUnavailableError('no running grokrc daemon')
            : new Error(`control socket error: ${err.message}`)
        )
      );
    });

    sock.on('close', () =>
      finish(() => reject(new ControlUnavailableError('daemon closed the control connection')))
    );
  });
}

/** True when a daemon is listening and answering. */
export async function daemonRunning(path: string = CONTROL_SOCKET_PATH): Promise<boolean> {
  try {
    await controlRequest('ping', undefined, path);
    return true;
  } catch {
    return false;
  }
}
