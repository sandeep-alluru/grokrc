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
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';

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
  /** 'up' client→daemon, 'down' daemon→client, plus connection lifecycle. */
  t: 'up' | 'down' | 'open' | 'close';
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
  #http = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'grokrc-relay' }));
  });
  #wss = new WebSocketServer({ noServer: true });
  #nextClientId = 1;

  constructor() {
    this.#http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://relay');
      const roomId = url.searchParams.get('room');
      const key = url.searchParams.get('key');
      const role = url.pathname === '/agent' ? 'daemon' : url.pathname === '/client' ? 'client' : null;

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
        role === 'daemon' ? this.#attachDaemon(r, ws) : this.#attachClient(r, ws);
      });
    });
  }

  #attachDaemon(room: Room, ws: WebSocket): void {
    // One daemon per room; a reconnect supersedes the stale socket.
    room.daemon?.close();
    room.daemon = ws;

    ws.on('message', (raw) => {
      let frame: RelayFrame;
      try {
        frame = JSON.parse(raw.toString()) as RelayFrame;
      } catch {
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
      this.#toDaemon(room, { c: id, t: 'up', d: raw.toString() });
    });

    const drop = () => {
      if (!room.clients.delete(id)) return;
      this.#toDaemon(room, { c: id, t: 'close' });
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  #toDaemon(room: Room, frame: RelayFrame): void {
    if (room.daemon?.readyState === 1) room.daemon.send(JSON.stringify(frame));
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
  relay.listen(port).then((p) => console.log(`grokrc relay listening on :${p}`));
}
