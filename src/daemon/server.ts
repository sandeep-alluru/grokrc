/**
 * The daemon's front door: static PWA + pairing endpoint + authenticated
 * WebSocket carrying RcEvents.
 *
 * Binds to loopback by default. Exposure is opt-in and the CLI says so loudly.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { AuthStore, type Device } from './auth.ts';
import type { RcEvent } from './events.ts';
import type { PushService } from './push.ts';
import { SessionManager } from './session-manager.ts';

export interface ServerOptions {
  host?: string;
  port?: number;
  webRoot: string;
  sessions: SessionManager;
  auth: AuthStore;
  /** Omit to disable push entirely. */
  push?: PushService;
  /** Default cwd for sessions created from a client that doesn't name one. */
  defaultCwd?: string;
}

type ClientMsg =
  | { t: 'hello'; token: string }
  | { t: 'sessions' }
  | { t: 'open'; sessionId: string; cwd?: string }
  | { t: 'create'; cwd?: string; model?: string; title?: string }
  | { t: 'prompt'; sessionId: string; text: string }
  | { t: 'approve'; sessionId: string; requestId: string; optionId: string | null }
  | { t: 'cancel'; sessionId: string }
  | { t: 'close'; sessionId: string };

interface Client {
  ws: WebSocket;
  device: Device | null;
  /** Sessions this client is watching; events for others aren't forwarded. */
  watching: Set<string>;
  /** Observed sessions this client caused to be tailed — refcounts released on disconnect. */
  observing: Set<string>;
}

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

export class RemoteControlServer {
  #http: Server;
  #wss: WebSocketServer;
  #clients = new Set<Client>();
  #opts: Required<Pick<ServerOptions, 'host' | 'port'>> & ServerOptions;
  #relayLink: import('ws').WebSocket | null = null;
  #closed = false;

  constructor(opts: ServerOptions) {
    this.#opts = { host: opts.host ?? '127.0.0.1', port: opts.port ?? 4319, ...opts };

    this.#http = createServer((req, res) => void this.#onHttp(req, res));
    this.#wss = new WebSocketServer({ server: this.#http });
    this.#wss.on('connection', (ws) => this.#onConnection(ws));

    // Fan out every session event to the clients watching that session.
    this.#opts.sessions.on('event', (ev: RcEvent) => {
      const sid = 'sessionId' in ev ? ev.sessionId : undefined;
      for (const c of this.#clients) {
        if (!c.device) continue;
        if (sid && !c.watching.has(sid)) continue;
        send(c.ws, { t: 'event', event: ev });
      }

      // Push regardless of connected sockets: a live socket means the app is
      // backgrounded, not that a human is looking at it. This is the whole
      // reason the agent stops being silently blocked.
      const push = this.#opts.push;
      if (!push) return;
      if (ev.k === 'approval') {
        const title = sid ? this.#opts.sessions.get(sid)?.title ?? 'session' : 'session';
        void push.notifyApproval(ev, title);
      } else if (ev.k === 'status' && ev.state === 'done' && sid) {
        void push.notifyDone(sid, this.#opts.sessions.get(sid)?.title ?? 'session');
      }
    });

    this.#opts.sessions.on('session-list-changed', () => {
      void this.#broadcastSessions();
    });
  }

  /**
   * Dial OUT to a relay so no port has to be open on this machine.
   *
   * The relay multiplexes every phone over one socket, tagging frames with a
   * client id. Each id becomes a virtual connection that walks the exact same
   * auth and message path as a direct WebSocket — pairing and token checks are
   * not bypassed just because the bytes arrived via a relay.
   */
  connectRelay(opts: { url: string; room: string; key: string }): void {
    const url = `${opts.url}/agent?room=${encodeURIComponent(opts.room)}&key=${encodeURIComponent(opts.key)}`;
    let backoff = 500;

    const dial = async () => {
      const { WebSocket } = await import('ws');
      const link = new WebSocket(url);
      const virtual = new Map<string, VirtualSocket>();

      link.on('open', () => {
        backoff = 500;
        console.log('  relay connected');
      });

      this.#relayLink = link;

      link.on('message', (raw) => {
        let frame: { c: string; t: string; d?: string };
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (frame.t === 'open') {
          // `d` travels as an already-encoded string; send it through untouched
          // or the relay round trip double-encodes every payload.
          const vs = new VirtualSocket((payload) =>
            link.send(JSON.stringify({ c: frame.c, t: 'down', d: payload }))
          );
          virtual.set(frame.c, vs);
          this.#onConnection(vs as unknown as WebSocket);
          return;
        }
        const vs = virtual.get(frame.c);
        if (!vs) return;
        if (frame.t === 'close') {
          virtual.delete(frame.c);
          vs.emit('close');
          return;
        }
        if (frame.d !== undefined) vs.emit('message', Buffer.from(frame.d));
      });

      const retry = () => {
        for (const vs of virtual.values()) vs.emit('close');
        virtual.clear();
        // Without this guard the reconnect loop outlives close() and keeps the
        // process (and the test runner) alive forever.
        if (this.#closed) return;
        const t = setTimeout(() => void dial(), backoff);
        t.unref?.();
        backoff = Math.min(backoff * 2, 30_000);
      };
      link.on('close', retry);
      link.on('error', () => {});
    };

    void dial();
  }

  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((res, rej) => {
      this.#http.once('error', rej);
      this.#http.listen(this.#opts.port, this.#opts.host, () => res());
    });
    const addr = this.#http.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.#opts.port;
    return { host: this.#opts.host, port };
  }

  async close(): Promise<void> {
    this.#closed = true; // stops the relay reconnect loop
    this.#relayLink?.close();
    this.#relayLink = null;
    for (const c of this.#clients) c.ws.close();
    this.#wss.close();
    await new Promise<void>((res) => this.#http.close(() => res()));
  }

  /* ─── HTTP ────────────────────────────────────────────────────────────── */

  async #onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/pair' && req.method === 'POST') {
      return this.#handlePair(req, res);
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, version: '0.1.0' });
    }

    if (url.pathname === '/api/push/key') {
      return json(res, 200, { publicKey: this.#opts.push?.publicKey ?? null });
    }

    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      return this.#handleSubscribe(req, res);
    }

    // Static PWA. Path is normalized and confined to webRoot.
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const root = resolve(this.#opts.webRoot);
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

  /** Register a push endpoint. Requires a valid device token — pushes are not open to anyone. */
  async #handleSubscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const push = this.#opts.push;
    if (!push) return json(res, 503, { error: 'push not enabled' });

    const raw = await readBody(req, 8192);
    if (raw === null) return json(res, 413, { error: 'too large' });

    let body: { token?: string; subscription?: unknown };
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }

    const device = body.token ? await this.#opts.auth.verify(body.token) : null;
    if (!device) return json(res, 401, { error: 'unauthorized' });
    if (!body.subscription) return json(res, 400, { error: 'subscription required' });

    await push.subscribe(device.id, body.subscription as never);
    json(res, 200, { ok: true });
  }

  async #handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) {
        req.destroy();
        return json(res, 413, { error: 'too large' });
      }
    }
    let body: { code?: string; deviceName?: string };
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }
    if (!body.code) return json(res, 400, { error: 'code required' });

    const result = await this.#opts.auth.redeem(body.code, body.deviceName ?? 'device');
    if (!result) {
      // Deliberately identical for wrong/expired/absent — don't confirm code validity.
      return json(res, 401, { error: 'invalid or expired pairing code' });
    }
    json(res, 200, { token: result.token, deviceId: result.device.id });
  }

  /* ─── WebSocket ───────────────────────────────────────────────────────── */

  #onConnection(ws: WebSocket): void {
    const client: Client = { ws, device: null, watching: new Set(), observing: new Set() };
    this.#clients.add(client);

    // Unauthenticated sockets are cheap to open; don't let them linger.
    const authTimer = setTimeout(() => {
      if (!client.device) ws.close(4401, 'auth timeout');
    }, 10_000);
    authTimer.unref?.();

    ws.on('message', (data) => void this.#onMessage(client, data.toString()));
    const cleanup = () => {
      clearTimeout(authTimer);
      // Release tailers this client started, or they leak on every disconnect.
      for (const id of client.observing) this.#opts.sessions.unobserve(id);
      client.observing.clear();
      this.#clients.delete(client);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  async #onMessage(client: Client, raw: string): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return send(client.ws, { t: 'error', message: 'invalid json' });
    }

    if (msg.t === 'hello') {
      const device = await this.#opts.auth.verify(msg.token);
      if (!device) {
        send(client.ws, { t: 'error', message: 'unauthorized' });
        client.ws.close(4401, 'unauthorized');
        return;
      }
      client.device = device;
      send(client.ws, { t: 'ready', device: { id: device.id, name: device.name } });
      await this.#sendSessions(client);
      return;
    }

    if (!client.device) {
      send(client.ws, { t: 'error', message: 'unauthorized' });
      client.ws.close(4401, 'unauthorized');
      return;
    }

    const sessions = this.#opts.sessions;
    try {
      switch (msg.t) {
        case 'sessions':
          await this.#sendSessions(client);
          return;

        case 'open': {
          client.watching.add(msg.sessionId);
          // A session we don't own (started by hand in a terminal) needs its log
          // tailer started before there is any history to send.
          if (!sessions.get(msg.sessionId) && msg.cwd) {
            await sessions.observe(msg.sessionId, msg.cwd);
            client.observing.add(msg.sessionId);
          }
          send(client.ws, {
            t: 'history',
            sessionId: msg.sessionId,
            events: sessions.history(msg.sessionId),
          });
          return;
        }

        case 'create': {
          const info = await sessions.create(msg.cwd ?? this.#opts.defaultCwd ?? process.cwd(), {
            model: msg.model,
            title: msg.title,
          });
          client.watching.add(info.id);
          send(client.ws, { t: 'created', session: info });
          return;
        }

        case 'prompt':
          client.watching.add(msg.sessionId);
          // Not awaited: a turn runs for minutes and events stream meanwhile.
          void sessions.prompt(msg.sessionId, msg.text).catch(() => {});
          return;

        case 'approve': {
          const ok = sessions.respondToApproval(msg.sessionId, msg.requestId, msg.optionId);
          if (!ok) send(client.ws, { t: 'error', message: 'approval no longer pending' });
          return;
        }

        case 'cancel':
          sessions.cancel(msg.sessionId);
          return;

        case 'close':
          if (client.observing.delete(msg.sessionId)) sessions.unobserve(msg.sessionId);
          else sessions.close(msg.sessionId);
          client.watching.delete(msg.sessionId);
          return;

        default:
          send(client.ws, { t: 'error', message: `unknown message: ${(msg as { t: string }).t}` });
      }
    } catch (err) {
      send(client.ws, { t: 'error', message: (err as Error).message });
    }
  }

  async #sendSessions(client: Client): Promise<void> {
    const live = this.#opts.sessions.list();
    const onDisk = await this.#opts.sessions.discoverOnDisk();
    const liveIds = new Set(live.map((s) => s.id));
    send(client.ws, {
      t: 'sessions',
      sessions: [...live, ...onDisk.filter((s) => !liveIds.has(s.id))],
    });
  }

  async #broadcastSessions(): Promise<void> {
    for (const c of this.#clients) {
      if (c.device) await this.#sendSessions(c);
    }
  }
}

/**
 * Presents a relay-multiplexed client as something the server can treat exactly
 * like a real WebSocket, so relay and direct connections share one code path —
 * including authentication. Implements only the surface the server actually
 * touches: send/close/readyState and the message/close/error events.
 */
class VirtualSocket extends EventEmitter {
  readyState = 1;
  #out: (payload: string) => void;

  constructor(out: (payload: string) => void) {
    super();
    this.#out = out;
    this.once('close', () => (this.readyState = 3));
  }

  send(data: string): void {
    if (this.readyState === 1) this.#out(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) {
      req.destroy();
      return null;
    }
  }
  return raw;
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}
