/**
 * The daemon's front door: static PWA + pairing endpoint + authenticated
 * WebSocket carrying RcEvents.
 *
 * Binds to loopback by default. Exposure is opt-in and the CLI says so loudly.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  /**
   * How many past (read-only) sessions to list. Live sessions are always shown.
   * Grok accumulates a directory per session forever, so an uncapped list buries
   * the one you actually want under months of history.
   */
  historyLimit?: number;
}

type ClientMsg =
  | { t: 'hello'; token: string; assetVersion?: string }
  | { t: 'sessions' }
  | { t: 'open'; sessionId: string; cwd?: string }
  | { t: 'resume'; sessionId: string; cwd: string }
  | { t: 'takeover'; sessionId: string; cwd: string }
  | { t: 'release'; sessionId: string }
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

/**
 * The real package version.
 *
 * Was hardcoded in two places and drifted the moment the version was bumped —
 * `/api/health` reported 0.1.0 from a 0.1.1 build. Read it from package.json,
 * which is the only copy that ships.
 */
let PKG_VERSION: string | null = null;
async function version(): Promise<string> {
  if (PKG_VERSION) return PKG_VERSION;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../../package.json', '../../../package.json']) {
      try {
        const raw = await readFile(resolve(here, rel), 'utf8');
        const v = JSON.parse(raw) as { name?: string; version?: string };
        if (v.name === 'grokrc' && v.version) return (PKG_VERSION = v.version);
      } catch {
        /* try the next candidate */
      }
    }
  } catch {
    /* fall through */
  }
  return (PKG_VERSION = 'unknown');
}

/**
 * How much of a transcript to send a client.
 *
 * `historyLimit` caps how many SESSIONS are listed; nothing capped the EVENTS
 * sent for one of them. A long-running session reached 2000 events / 4.5 MB,
 * which the phone then rendered into 1.6 million characters of DOM. iOS Safari
 * answers that with "A problem repeatedly occurred" and gives up.
 *
 * The tail is what anyone actually reads on a phone. Older events stay on the
 * daemon and in Grok's own log; they are not lost, just not shipped.
 */
const HISTORY_EVENT_LIMIT = 300;

/**
 * No single event should be able to bury a phone on its own.
 *
 * The median event in a real session is 1.6 KB; the largest measured is 117 KB.
 * A handful of those is most of the payload, and none of it is readable on a
 * 390px screen — it is tool output, pasted files, and encoded images.
 */
const EVENT_TEXT_LIMIT = 4000;

function trimEvent(ev: RcEvent): RcEvent {
  // Walk the whole event, not just `.text`. The bulk of a large transcript is
  // in tool_call_update payloads — content[].newText, rawOutput, _meta.details —
  // and an earlier version of this trimmed only the top-level text field, which
  // changed the measured payload by exactly nothing.
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v.length <= EVENT_TEXT_LIMIT) return v;
      const cut = v.length - EVENT_TEXT_LIMIT;
      return `${v.slice(0, EVENT_TEXT_LIMIT)}\n\n… ${cut.toLocaleString()} more characters not shown …`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return walk(ev) as RcEvent;
}

/** The tail of a transcript, plus a marker when anything was left behind. */
function trimHistory(events: RcEvent[]): RcEvent[] {
  if (events.length <= HISTORY_EVENT_LIMIT) return events.map(trimEvent);
  const dropped = events.length - HISTORY_EVENT_LIMIT;
  const head: RcEvent = {
    k: 'text',
    sessionId: events[0]?.sessionId ?? '',
    role: 'agent',
    text: `— ${dropped} earlier event(s) not shown —`,
    final: true,
  };
  return [head, ...events.slice(-HISTORY_EVENT_LIMIT).map(trimEvent)];
}

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
    // Cap frame size so a hostile or buggy client can't exhaust memory with one
    // message. Prompts are text; 1 MiB is generous.
    this.#wss = new WebSocketServer({ server: this.#http, maxPayload: 1024 * 1024 });
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
        const title = sid ? (this.#opts.sessions.get(sid)?.title ?? 'session') : 'session';
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
  connectRelay(opts: { url: string; room: string; key: string; secret?: string }): void {
    const url = `${opts.url}/agent?room=${encodeURIComponent(opts.room)}&key=${encodeURIComponent(opts.key)}`;
    let backoff = 500;

    const dial = async () => {
      const { WebSocket } = await import('ws');

      // Encryption sits at the relay boundary only: direct LAN clients are
      // same-origin and unaffected, and the relay itself needs no changes
      // because it already forwards `d` opaquely.
      const crypto = opts.secret ? await loadRelayCrypto(opts.secret) : null;
      // Serialize crypto through one chain so frames cannot reorder.
      let chain: Promise<unknown> = Promise.resolve();
      const ordered = <T>(fn: () => Promise<T>): Promise<T> => {
        const next = chain.then(fn, fn);
        chain = next.catch(() => {});
        return next as Promise<T>;
      };
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
        // An /api/* call tunnelled from the relay. Answered through the same
        // handlers as a direct request, so pairing over a relay is not a
        // separate, weaker code path.
        if (frame.t === 'http') {
          // The relay wraps the request as {method,path,body}; the BROWSER seals
          // only `body`. So the envelope lives one level in — decrypting the
          // whole frame would just hand us the wrapper back.
          void ordered(async () => {
            await this.#handleTunnelledHttp(frame.c, frame.d ?? '{}', crypto, (status, body) => {
              void ordered(async () => {
                const payload = JSON.stringify({
                  status,
                  body: crypto ? await crypto.encrypt(body) : body,
                });
                link.send(JSON.stringify({ c: frame.c, t: 'http-res', d: payload }));
              });
            });
          });
          return;
        }

        if (frame.t === 'open') {
          // `d` travels as an already-encoded string; send it through untouched
          // or the relay round trip double-encodes every payload.
          const vs = new VirtualSocket((payload) => {
            void ordered(async () => {
              const d = crypto ? await crypto.encrypt(payload) : payload;
              link.send(JSON.stringify({ c: frame.c, t: 'down', d }));
            });
          });
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
        if (frame.d !== undefined) {
          void ordered(async () => {
            try {
              const plain = crypto ? await crypto.decrypt(frame.d!) : frame.d!;
              vs.emit('message', Buffer.from(plain));
            } catch {
              // Authenticated encryption failing means a tampered or
              // wrong-key frame. Drop the client rather than process it.
              vs.emit('close');
              virtual.delete(frame.c);
            }
          });
        }
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

  /**
   * Serve an /api/* call that arrived via the relay rather than over HTTP.
   * Reuses the same auth checks as the direct path — arriving through a relay
   * grants nothing extra.
   */
  async #handleTunnelledHttp(
    _id: string,
    raw: string,
    crypto: { decrypt(s: string): Promise<string> } | null,
    reply: (status: number, body: string) => void
  ): Promise<void> {
    let req: { method?: string; path?: string; body?: string };
    try {
      req = JSON.parse(raw);
    } catch {
      return reply(400, JSON.stringify({ error: 'invalid tunnel frame' }));
    }

    // Unseal the request body the browser encrypted end-to-end.
    if (crypto && req.body) {
      try {
        req.body = await crypto.decrypt(req.body);
      } catch {
        return reply(400, JSON.stringify({ error: 'decryption failed' }));
      }
    }

    const send = (status: number, payload: unknown) => reply(status, JSON.stringify(payload));

    try {
      if (req.path === '/api/health') return send(200, { ok: true, version: await version() });

      if (req.path === '/api/push/key') {
        return send(200, { publicKey: this.#opts.push?.publicKey ?? null });
      }

      if (req.path === '/api/pair' && req.method === 'POST') {
        const body = JSON.parse(req.body || '{}') as { code?: string; deviceName?: string };
        if (!body.code) return send(400, { error: 'code required' });
        const result = await this.#opts.auth.redeem(body.code, body.deviceName ?? 'device');
        return result
          ? send(200, { token: result.token, deviceId: result.device.id })
          : send(401, { error: 'invalid or expired pairing code' });
      }

      if (req.path === '/api/push/subscribe' && req.method === 'POST') {
        const push = this.#opts.push;
        if (!push) return send(503, { error: 'push not enabled' });
        const body = JSON.parse(req.body || '{}') as { token?: string; subscription?: unknown };
        const device = body.token ? await this.#opts.auth.verify(body.token) : null;
        if (!device) return send(401, { error: 'unauthorized' });
        if (!body.subscription) return send(400, { error: 'subscription required' });
        await push.subscribe(device.id, body.subscription as never);
        return send(200, { ok: true });
      }

      send(404, { error: 'not found' });
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
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

  #assetVersion: { mtimeMs: number; hash: string } | null = null;

  /**
   * Short content hash of the client bundle.
   *
   * Keyed on mtime so an edit during development is picked up without a
   * restart, and hashing is not repeated for every request.
   */
  async assetVersion(): Promise<string> {
    const file = join(resolve(this.#opts.webRoot), 'app.js');
    try {
      const { mtimeMs } = await stat(file);
      if (this.#assetVersion?.mtimeMs === mtimeMs) return this.#assetVersion.hash;
      const hash = createHash('sha256')
        .update(await readFile(file))
        .digest('hex')
        .slice(0, 12);
      this.#assetVersion = { mtimeMs, hash };
      return hash;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Settings the server consults per request, so they can change while it runs.
   *
   * host/port are NOT here: the socket is already bound, and pretending
   * otherwise would report success for a change that did not happen.
   */
  applyConfig(next: { defaultCwd?: string; historyLimit?: number }): void {
    if (typeof next.defaultCwd === 'string') this.#opts.defaultCwd = next.defaultCwd;
    if (typeof next.historyLimit === 'number') this.#opts.historyLimit = next.historyLimit;
  }

  /**
   * Device ids holding a live authenticated socket right now.
   *
   * This is the one thing `grokrc devices` cannot learn by reading auth.json —
   * the store records when a device last spoke, not whether it is here.
   */
  connectedDeviceIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.#clients) if (c.device) ids.add(c.device.id);
    return ids;
  }

  /**
   * Close every socket belonging to a device, used when it is revoked.
   *
   * Revoking by writing to the store alone leaves an already-connected phone
   * driving the agent until it happens to reconnect. 4401 is the code the client
   * treats as "token rejected": it discards the token and returns to pairing
   * rather than reconnect-looping.
   */
  disconnectDevice(deviceId: string): number {
    let n = 0;
    for (const c of this.#clients) {
      if (c.device?.id === deviceId) {
        c.ws.close(4401, 'device revoked');
        n++;
      }
    }
    return n;
  }

  /* ─── HTTP ────────────────────────────────────────────────────────────── */

  async #onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/pair' && req.method === 'POST') {
      return this.#handlePair(req, res);
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, version: await version() });
    }

    if (url.pathname === '/api/push/key') {
      return json(res, 200, { publicKey: this.#opts.push?.publicKey ?? null });
    }

    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      return this.#handleSubscribe(req, res);
    }

    if (url.pathname === '/api/version') {
      return json(res, 200, { assetVersion: await this.assetVersion() });
    }

    // Static PWA. Path is normalized and confined to webRoot.
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const root = resolve(this.#opts.webRoot);
    const target = resolve(join(root, normalize(rel)));
    if (!target.startsWith(root + '/') && target !== root) {
      return json(res, 403, { error: 'forbidden' });
    }
    try {
      let body: Buffer | string = await readFile(target);

      // Stamp the app's URL with a hash of its contents. `cache-control:
      // no-cache` asks a browser to revalidate, but an installed PWA can serve
      // an old copy anyway — a phone ran yesterday's JavaScript against a fixed
      // daemon and the bug looked unfixed. A changed hash is a different URL,
      // so there is nothing stale to serve.
      if (target === join(root, 'index.html')) {
        const v = await this.assetVersion();
        body = body.toString('utf8').replace('src="/app.js"', `src="/app.js?v=${v}"`);
      }

      res.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
        // The stamped URL is immutable; everything else must revalidate.
        'cache-control': url.searchParams.has('v')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
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
      // leaderMode tells the client whether a session another process owns can
      // be joined (shared backend) or only watched.
      const current = await this.assetVersion();
      if (msg.assetVersion && msg.assetVersion !== current) {
        // Worth a line on the machine: "is this a bug or an old client?" was
        // unanswerable, and cost a round trip to establish.
        console.log(
          `  stale client: device ${device.id} is running ${msg.assetVersion}, current is ${current}`
        );
      }
      send(client.ws, {
        t: 'ready',
        device: { id: device.id, name: device.name },
        leaderMode: this.#opts.sessions.leaderMode,
        assetVersion: current,
        stale: !!msg.assetVersion && msg.assetVersion !== current,
      });
      await this.#sendSessions(client);
      return;
    }

    if (!client.device) {
      send(client.ws, { t: 'error', message: 'unauthorized' });
      client.ws.close(4401, 'unauthorized');
      return;
    }

    // Validate shapes before use. Field types arrive from a remote client, and
    // a non-string sessionId would flow into Map lookups and path building as
    // whatever it happens to be — the daemon should reject it, not coerce it.
    const shapeError = validateShape(msg);
    if (shapeError) {
      send(client.ws, { t: 'error', message: shapeError });
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
            events: trimHistory(sessions.history(msg.sessionId)),
          });
          return;
        }

        case 'resume': {
          // Turn a read-only past session into a live one you can keep talking to.
          const info = await sessions.resume(msg.sessionId, msg.cwd);
          client.observing.delete(msg.sessionId);
          client.watching.add(info.id);
          send(client.ws, { t: 'resumed', session: info });
          send(client.ws, {
            t: 'history',
            sessionId: info.id,
            events: trimHistory(sessions.history(info.id)),
          });
          return;
        }

        case 'takeover': {
          // Stops the terminal process that owns this session, then resumes it
          // here. Destructive, and the client is expected to have confirmed.
          //
          // Logged on the MACHINE, not just returned to the phone: this is the
          // one action that kills a process, and "did my tap do anything?" was
          // unanswerable from the daemon's own log the first time it was used.
          console.log(
            `  takeover requested: session ${msg.sessionId} by device ${client.device?.id ?? '?'}`
          );
          const info = await sessions.takeOver(msg.sessionId, msg.cwd);
          console.log(`  takeover succeeded: session ${info.id} is now owned here`);
          client.observing.delete(msg.sessionId);
          client.watching.add(info.id);
          send(client.ws, { t: 'resumed', session: info });
          send(client.ws, {
            t: 'history',
            sessionId: info.id,
            events: trimHistory(sessions.history(info.id)),
          });
          void this.#broadcastSessions();
          return;
        }

        case 'release': {
          // Hand the session back to a terminal. The daemon must let go first —
          // two agents on one conversation is what externallyActive prevents.
          console.log(
            `  release requested: session ${msg.sessionId} by device ${client.device?.id ?? '?'}`
          );
          const info = sessions.list().find((s) => s.id === msg.sessionId);
          sessions.close(msg.sessionId);
          client.watching.delete(msg.sessionId);
          send(client.ws, {
            t: 'released',
            sessionId: msg.sessionId,
            // The exact command to get it back in the TUI, so the user does not
            // have to reconstruct it from a session id and a path.
            command: info ? `cd ${info.cwd} && grok -r ${msg.sessionId}` : null,
          });
          void this.#broadcastSessions();
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
          // But failures MUST surface — swallowing them meant prompting a
          // read-only session did nothing at all, with no feedback.
          void sessions.prompt(msg.sessionId, msg.text).catch((err: Error) => {
            send(client.ws, { t: 'error', message: err.message });
          });
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
      // Client-only error reporting left destructive actions invisible in the
      // daemon log — you could not tell a refused takeover from a tap that
      // never arrived.
      if (msg.t === 'takeover' || msg.t === 'release' || msg.t === 'resume') {
        console.log(`  ${msg.t} FAILED: ${(err as Error).message}`);
      }
      send(client.ws, { t: 'error', message: (err as Error).message });
    }
  }

  async #sendSessions(client: Client): Promise<void> {
    const live = this.#opts.sessions.list();
    const limit = this.#opts.historyLimit ?? 10;
    const onDisk = await this.#opts.sessions.discoverOnDisk(limit);
    const liveIds = new Set(live.map((s) => s.id));
    // Live sessions always appear; history is capped to the most recent.
    send(client.ws, {
      t: 'sessions',
      sessions: [...live, ...onDisk.filter((s) => !liveIds.has(s.id)).slice(0, limit)],
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

/**
 * Load the shared crypto module — the same `web/crypto.js` the browser runs, so
 * both ends cannot drift apart. Resolved relative to this file, which sits at
 * the same depth in `src/` and `dist/`.
 */
async function loadRelayCrypto(secret: string) {
  const { pathToFileURL } = await import('node:url');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const mod = (await import(
    pathToFileURL(resolve(here, '../../web/crypto.js')).href
  )) as typeof import('../../web/crypto.js');

  const key = await mod.deriveKey(secret);
  return {
    async encrypt(plaintext: string): Promise<string> {
      return JSON.stringify(await mod.seal(key, plaintext));
    },
    async decrypt(wire: string): Promise<string> {
      const parsed = JSON.parse(wire) as unknown;
      // Tolerate plaintext during rollout, but never silently accept it as
      // authenticated — callers treat a decrypt failure as fatal for the client.
      if (!mod.isEnvelope(parsed)) return wire;
      return mod.open(key, parsed as { n: string; c: string });
    },
  };
}

/**
 * Per-message field checks for the client protocol.
 *
 * Deliberately hand-written rather than pulled from a schema library: the
 * surface is eight messages, and a dependency here would be more code than it
 * replaces. Returns an error string, or null when the shape is acceptable.
 */
function validateShape(msg: Record<string, unknown>): string | null {
  const str = (k: string, required = true): string | null => {
    const v = msg[k];
    if (v === undefined || v === null) return required ? `${k} is required` : null;
    if (typeof v !== 'string') return `${k} must be a string`;
    if (v.length > 100_000) return `${k} is too long`;
    return null;
  };

  switch (msg.t) {
    case 'sessions':
      return null;
    case 'open':
      return str('sessionId') ?? str('cwd', false);
    case 'resume':
    case 'takeover':
      return str('sessionId') ?? str('cwd');
    case 'release':
      return str('sessionId');
    case 'create':
      return str('cwd', false) ?? str('model', false) ?? str('title', false);
    case 'prompt':
      return str('sessionId') ?? str('text');
    case 'approve': {
      const e = str('sessionId') ?? str('requestId');
      if (e) return e;
      // optionId may legitimately be null — that cancels the request.
      if (msg.optionId !== null && typeof msg.optionId !== 'string') {
        return 'optionId must be a string or null';
      }
      return null;
    }
    case 'cancel':
    case 'close':
      return str('sessionId');
    default:
      return `unknown message: ${String(msg.t).slice(0, 40)}`;
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
