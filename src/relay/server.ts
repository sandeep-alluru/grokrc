/**
 * Relay — a dumb, self-hostable forwarder.
 *
 * Purpose: remove the inbound port. The daemon on your dev machine dials OUT to
 * this, your phone dials in, and frames are piped between them. Nothing listens
 * on your laptop, so it works from cellular with no Tailnet and no port forward.
 *
 * The relay is deliberately stupid. It does not parse ACP, does not hold
 * sessions, and does not know what an approval is — it moves opaque frames
 * between one daemon and N clients within a room. Everything meaningful stays on
 * the dev machine, which is what makes it safe to run on a cheap VPS.
 *
 * Why not point `grok agent headless --grok-ws-url` straight at it? That does
 * work — the probe in docs/captures/relay-probe.json shows the agent speaking
 * plain ACP over its outbound socket. But it would bypass the daemon, and with
 * it the event normalization and the held-approval state that make the phone
 * client usable. So the daemon dials out and the agent stays on stdio.
 *
 *   node dist/relay/server.js --port 8080
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

interface Room {
  id: string;
  key: string;
  daemon: WebSocket | null;
  clients: Map<string, WebSocket>;
}

/**
 * Frames on the daemon side are tagged so one socket carries every client.
 *
 * `d` is always the *raw* payload string, never a parsed object. The relay never
 * decodes it — that keeps the forwarder genuinely opaque, and avoids the
 * parse/re-encode round trip that silently double-encodes payloads.
 */
export interface RelayFrame {
  /** Which phone this frame belongs to. */
  c: string;
  /**
   * 'up'/'down' carry WebSocket payloads; 'open'/'close' are lifecycle;
   * 'http'/'http-res' tunnel an /api/* call so pairing works through the relay.
   */
  t: 'up' | 'down' | 'open' | 'close' | 'http' | 'http-res';
  d?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class RelayServer {
  #rooms = new Map<string, Room>();
  #webRoot: string;
  #onFrame?: (raw: string) => void;
  /**
   * Tunnelled HTTP requests awaiting a daemon reply.
   *
   * Each entry records the room that OWNS it. Without that, any daemon could
   * answer any pending id — and ids were a global sequential counter, so they
   * were trivially guessable. A relay hosting two daemons let one answer the
   * other's `/api/pair` with a forged device token.
   */
  #pendingHttp = new Map<
    string,
    { roomId: string; respond: (status: number, body: string) => void }
  >();
  /**
   * The relay must serve the app itself, not just forward sockets — a phone on
   * cellular has no route to the daemon's HTTP listener, so without this there
   * is no way to load or pair the client remotely.
   *
   * Static assets are served from the relay's own copy of `web/`. Anything under
   * `/api/` is tunnelled to the daemon over the existing WebSocket, so pairing
   * and push registration work without opening a port on the dev machine.
   */
  #http = createServer((req, res) => void this.#onHttp(req, res));
  #wss = new WebSocketServer({ noServer: true });
  #nextClientId = 1;

  constructor(opts: { webRoot?: string; onFrame?: (raw: string) => void } = {}) {
    this.#webRoot = opts.webRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
    // Observation hook: sees exactly what the relay sees. Used by the
    // end-to-end encryption test to prove the relay never handles plaintext —
    // a claim that has to be mechanically checked, not asserted in prose.
    this.#onFrame = opts.onFrame;

    this.#http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://relay');
      const roomId = url.searchParams.get('room');
      const key = url.searchParams.get('key');
      const role =
        url.pathname === '/agent' ? 'daemon' : url.pathname === '/client' ? 'client' : null;

      if (!role || !roomId || !key) {
        socket.destroy();
        return;
      }

      let room = this.#rooms.get(roomId);
      if (!room) {
        // First party to name a room defines its key. Rooms are ephemeral and
        // die with their daemon, so this can't be squatted long-term.
        if (role !== 'daemon') return void socket.destroy();
        room = { id: roomId, key, daemon: null, clients: new Map() };
        this.#rooms.set(roomId, room);
      } else if (!safeEqual(key, room.key)) {
        return void socket.destroy();
      }

      const r = room;
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        if (role === 'daemon') this.#attachDaemon(r, ws);
        else this.#attachClient(r, ws);
      });
    });
  }

  async #onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay');

    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'grokrc-relay', rooms: this.#rooms.size });
    }

    // Tunnel /api/* to the daemon so pairing and push work through the relay.
    if (url.pathname.startsWith('/api/')) {
      return this.#proxyApi(req, res, url);
    }

    const rel = url.pathname === '/' || url.pathname === '/client' ? '/index.html' : url.pathname;
    const root = resolve(this.#webRoot);
    const target = resolve(join(root, normalize(rel)));
    if (!target.startsWith(root + '/') && target !== root) {
      return json(res, 403, { error: 'forbidden' });
    }
    try {
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }

  /**
   * Forward an HTTP API call to the daemon over the room's socket and wait for
   * its reply. The room is named by query string because the browser sends it
   * from the page's own URL.
   */
  async #proxyApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const roomId = url.searchParams.get('room');
    const room = roomId ? this.#rooms.get(roomId) : null;
    if (!room?.daemon) return json(res, 503, { error: 'no daemon for room' });

    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 16384) {
        req.destroy();
        return json(res, 413, { error: 'too large' });
      }
    }

    // Unguessable id AND a recorded owner. The id alone is not the control —
    // ownership is — but a random id removes the guessing game entirely.
    const id = `http-${randomUUID()}`;
    const timer = setTimeout(() => {
      if (this.#pendingHttp.delete(id)) json(res, 504, { error: 'daemon timeout' });
    }, 15_000);
    timer.unref?.(); // must not hold the process open on shutdown

    this.#pendingHttp.set(id, {
      roomId: room.id,
      respond: (status, payload) => {
        clearTimeout(timer);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(payload);
      },
    });

    this.#toDaemon(room, {
      c: id,
      t: 'http',
      d: JSON.stringify({ method: req.method, path: url.pathname, body }),
    });
  }

  #attachDaemon(room: Room, ws: WebSocket): void {
    // One daemon per room; a reconnect supersedes the stale socket.
    room.daemon?.close();
    room.daemon = ws;

    ws.on('message', (raw) => {
      let frame: RelayFrame;
      const text = raw.toString();
      this.#onFrame?.(text);
      try {
        frame = JSON.parse(text) as RelayFrame;
      } catch {
        return;
      }
      // Reply to a tunnelled HTTP request.
      if (frame.t === 'http-res') {
        const pending = this.#pendingHttp.get(frame.c);
        if (!pending) return;
        // A daemon may only answer requests belonging to ITS OWN room. Without
        // this, one tenant answers another's /api/pair with a forged token.
        if (pending.roomId !== room.id) return;
        this.#pendingHttp.delete(frame.c);
        const { status, body } = JSON.parse(frame.d ?? '{}') as { status: number; body: string };
        pending.respond(status, body);
        return;
      }

      const client = room.clients.get(frame.c);
      if (!client) return;
      if (frame.t === 'close') return void client.close();
      // Forward verbatim — `d` is already the encoded payload.
      if (client.readyState === 1 && frame.d !== undefined) client.send(frame.d);
    });

    const drop = () => {
      if (room.daemon !== ws) return;
      room.daemon = null;
      // The daemon is the only thing that can answer; without it clients are
      // talking to nobody. Close them rather than let the UI look connected.
      for (const c of room.clients.values()) c.close(4503, 'daemon disconnected');
      room.clients.clear();

      // Settle this room's in-flight requests now. Leaving them to their 15s
      // timeout makes a browser wait a quarter minute for an answer that can
      // never come, and holds the entries in memory meanwhile.
      for (const [id, p] of this.#pendingHttp) {
        if (p.roomId !== room.id) continue;
        this.#pendingHttp.delete(id);
        p.respond(503, JSON.stringify({ error: 'daemon disconnected' }));
      }

      this.#rooms.delete(room.id);
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  #attachClient(room: Room, ws: WebSocket): void {
    if (!room.daemon) return void ws.close(4503, 'no daemon');
    const id = String(this.#nextClientId++);
    room.clients.set(id, ws);
    this.#toDaemon(room, { c: id, t: 'open' });

    ws.on('message', (raw) => {
      // Opaque passthrough; the daemon is the only thing that parses payloads.
      const text = raw.toString();
      this.#onFrame?.(text);
      this.#toDaemon(room, { c: id, t: 'up', d: text });
    });

    const drop = () => {
      if (!room.clients.delete(id)) return;
      this.#toDaemon(room, { c: id, t: 'close' });
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  #toDaemon(room: Room, frame: RelayFrame): void {
    const raw = JSON.stringify(frame);
    // Tap outbound too, so the observation hook sees everything the relay
    // handles — not just what arrives at it.
    this.#onFrame?.(raw);
    if (room.daemon?.readyState === 1) room.daemon.send(raw);
  }

  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    await new Promise<void>((res, rej) => {
      this.#http.once('error', rej);
      this.#http.listen(port, host, () => res());
    });
    const addr = this.#http.address();
    return typeof addr === 'object' && addr ? addr.port : port;
  }

  async close(): Promise<void> {
    for (const room of this.#rooms.values()) {
      room.daemon?.close();
      for (const c of room.clients.values()) c.close();
    }
    this.#rooms.clear();
    this.#wss.close();
    await new Promise<void>((res) => this.#http.close(() => res()));
  }
}

// Run standalone: node dist/relay/server.js --port 8080
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const i = process.argv.indexOf('--port');
  const port = i !== -1 ? Number(process.argv[i + 1]) : 8080;
  const relay = new RelayServer();
  // An unhandled rejection here (port in use, bad bind) would take the process
  // down with no explanation — report it and exit deliberately.
  relay.listen(port).then(
    (p) => console.log(`grokrc relay listening on :${p}`),
    (err: Error) => {
      console.error(`grokrc relay failed to start: ${err.message}`);
      process.exit(1);
    }
  );
}
