/**
 * Owns the agent processes and everything a late-joining client needs to catch up.
 *
 * The critical behaviour here is that **pending approvals are state, not
 * events**. Your phone is usually asleep when the agent asks to run something.
 * If approvals were only streamed, the request would arrive while nothing was
 * listening and the agent would sit blocked forever with no way to answer it.
 * So every unanswered `session/request_permission` is held in `pendingApprovals`
 * and replayed on connect.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcpClient, type PermissionRequest } from '../acp/client.ts';
import { StdioTransport, type Transport } from '../acp/transport.ts';
import { SessionObserver } from './observer.ts';
import {
  normalizePermission,
  normalizeSessionUpdate,
  type RcEvent,
  type SessionState,
} from './events.ts';

const GROK_HOME = process.env.GROK_HOME ?? join(homedir(), '.grok');

/** Per-session scrollback retained for reconnecting clients. */
const EVENT_LOG_LIMIT = 2000;

/**
 * Event kinds that genuinely interrupt a streamed message and so should close
 * it off. Everything else (status, commands, mode, raw, approval-resolved) is
 * metadata that interleaves freely and must NOT split the message.
 */
const INTERRUPTS_STREAM = new Set<RcEvent['k']>(['tool', 'plan', 'approval', 'error']);

export type SessionMode = 'owned' | 'shared' | 'observed';

export interface SessionInfo {
  id: string;
  cwd: string;
  title: string;
  model?: string;
  mode: SessionMode;
  state: SessionState;
  createdAt: number;
  updatedAt: number;
  pendingApprovals: number;
}

interface LiveSession {
  info: SessionInfo;
  client: AcpClient;
  log: RcEvent[];
  approvals: Map<string, PermissionRequest>;
  /**
   * The chunk run currently being accumulated. Agent text and thinking both
   * stream token-by-token and must each be coalesced into one block; tracking
   * the kind is what keeps them from merging into each other.
   */
  stream: { kind: 'text' | 'thinking'; text: string } | null;
}

interface ObservedSession {
  info: SessionInfo;
  observer: SessionObserver;
  log: RcEvent[];
  buffer: string;
  /** Clients currently watching; the tailer stops when this hits zero. */
  watchers: number;
}

export interface SessionManagerOptions {
  grokCommand?: string;
  model?: string;
  /** Share one backend with a running `grok agent leader`, so the TUI and phone
   *  drive the same session. */
  useLeader?: boolean;
  /** Custom leader socket path (default `~/.grok/leader.sock`). */
  leaderSocket?: string;
  /**
   * Override how the agent transport is created. Exists so tests can substitute
   * a scripted agent — driving the UI against real captured payloads without
   * spending tokens or inheriting model non-determinism.
   */
  transportFactory?: (cwd: string, model?: string) => Transport;
}

export class SessionManager extends EventEmitter {
  #sessions = new Map<string, LiveSession>();
  #observed = new Map<string, ObservedSession>();
  #opts: SessionManagerOptions;

  constructor(opts: SessionManagerOptions = {}) {
    super();
    this.#opts = opts;
  }

  /** Emitted for every event on any session. */
  override on(event: 'event', cb: (e: RcEvent) => void): this;
  override on(event: 'session-list-changed', cb: () => void): this;
  override on(event: string, cb: (...a: any[]) => void): this {
    return super.on(event, cb);
  }

  list(): SessionInfo[] {
    return [
      ...[...this.#sessions.values()].map((s) => ({
        ...s.info,
        pendingApprovals: s.approvals.size,
      })),
      ...[...this.#observed.values()].map((o) => ({ ...o.info })),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SessionInfo | undefined {
    const s = this.#sessions.get(id);
    if (s) return { ...s.info, pendingApprovals: s.approvals.size };
    const o = this.#observed.get(id);
    return o ? { ...o.info } : undefined;
  }

  /** Replay for a client that just connected or reopened a session. */
  history(id: string): RcEvent[] {
    const s = this.#sessions.get(id);
    if (!s) return this.#observed.get(id)?.log ?? [];
    // Pending approvals are re-emitted last so they land at the bottom of the
    // transcript, where the user will act on them.
    const pending = [...s.approvals.entries()].map(([requestId, req]) =>
      normalizePermission(requestId, req.params)
    );
    return [...s.log, ...pending];
  }

  /**
   * Start mirroring a session this daemon does not own — one the user started by
   * hand in a terminal. Read-only. Idempotent; refcounted by watcher.
   */
  async observe(id: string, cwd: string): Promise<SessionInfo> {
    const existing = this.#observed.get(id);
    if (existing) {
      existing.watchers++;
      return { ...existing.info };
    }

    const dir = join(GROK_HOME, 'sessions', encodeURIComponent(cwd), id);
    const now = Date.now();
    const obs: ObservedSession = {
      info: {
        id,
        cwd,
        title: defaultTitle(cwd),
        mode: 'observed',
        state: 'idle',
        createdAt: now,
        updatedAt: now,
        pendingApprovals: 0,
      },
      observer: new SessionObserver({ sessionDir: dir }),
      log: [],
      buffer: '',
      watchers: 1,
    };

    // Enrich from summary.json when present — best effort, never fatal.
    try {
      const s = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as SummaryFile;
      obs.info.title = s.session_summary || obs.info.title;
      obs.info.model = s.current_model_id;
      obs.info.createdAt = toMs(s.created_at);
      obs.info.updatedAt = toMs(s.updated_at);
    } catch {
      /* a session can exist before its summary is written */
    }

    obs.observer.on('event', (ev) => {
      // Same chunk coalescing as owned sessions, so replay yields whole messages.
      if (ev.k === 'text' && ev.role === 'agent' && !ev.final) {
        obs.buffer += ev.text;
        this.emit('event', { ...ev, sessionId: id });
        return;
      }
      if (obs.buffer) {
        const text = obs.buffer;
        obs.buffer = '';
        this.#pushObserved(obs, { k: 'text', sessionId: id, role: 'agent', text, final: true });
      }
      this.#pushObserved(obs, { ...ev, sessionId: id } as RcEvent);
    });

    obs.observer.on('error', (err) => {
      this.#pushObserved(obs, { k: 'error', sessionId: id, message: err.message, fatal: false });
    });

    this.#observed.set(id, obs);
    await obs.observer.start();
    this.emit('session-list-changed');
    return { ...obs.info };
  }

  /** Drop a watcher; stops tailing when the last one leaves. */
  unobserve(id: string): void {
    const obs = this.#observed.get(id);
    if (!obs) return;
    if (--obs.watchers > 0) return;
    obs.observer.stop();
    this.#observed.delete(id);
    this.emit('session-list-changed');
  }

  #pushObserved(obs: ObservedSession, ev: RcEvent): void {
    obs.log.push(ev);
    if (obs.log.length > EVENT_LOG_LIMIT) obs.log.splice(0, obs.log.length - EVENT_LOG_LIMIT);
    if (ev.k === 'status') obs.info.state = ev.state;
    obs.info.updatedAt = Date.now();
    this.emit('event', ev);
  }

  /* ─── lifecycle ───────────────────────────────────────────────────────── */

  async create(cwd: string, opts: { title?: string; model?: string } = {}): Promise<SessionInfo> {
    const model = opts.model ?? this.#opts.model;
    const transport =
      this.#opts.transportFactory?.(cwd, model) ??
      new StdioTransport({
        command: this.#opts.grokCommand ?? 'grok',
        cwd,
        model,
        useLeader: this.#opts.useLeader,
        leaderSocket: this.#opts.leaderSocket,
      });
    const client = new AcpClient({ transport });

    await client.initialize();
    const created = await client.newSession(cwd);
    const id = created.sessionId;

    const now = Date.now();
    const session: LiveSession = {
      info: {
        id,
        cwd,
        title: opts.title ?? defaultTitle(cwd),
        model: opts.model ?? this.#opts.model,
        mode: this.#opts.useLeader ? 'shared' : 'owned',
        state: 'idle',
        createdAt: now,
        updatedAt: now,
        pendingApprovals: 0,
      },
      client,
      log: [],
      approvals: new Map(),
      stream: null,
    };
    this.#sessions.set(id, session);
    this.#wire(session);
    this.emit('session-list-changed');
    return { ...session.info };
  }

  /** Run a turn. Resolves when the agent stops; events stream meanwhile. */
  async prompt(id: string, text: string): Promise<void> {
    const s = this.#require(id);
    this.#push(s, { k: 'text', sessionId: id, role: 'user', text, final: true });
    this.#setState(s, 'thinking');
    try {
      const res = await s.client.prompt(id, text);
      this.#flush(s);
      this.#setState(s, res.stopReason === 'cancelled' ? 'idle' : 'done');
    } catch (err) {
      this.#flush(s);
      this.#push(s, { k: 'error', sessionId: id, message: (err as Error).message, fatal: false });
      this.#setState(s, 'error');
      throw err;
    }
  }

  cancel(id: string): void {
    const s = this.#require(id);
    s.client.cancel(id);
    this.#setState(s, 'idle');
  }

  /** Answer a permission request. `optionId: null` cancels it. */
  respondToApproval(id: string, requestId: string, optionId: string | null): boolean {
    const s = this.#require(id);
    const req = s.approvals.get(requestId);
    if (!req) return false;
    s.approvals.delete(requestId);
    req.respond(optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId });
    this.#push(s, { k: 'approval-resolved', sessionId: id, requestId, optionId });
    this.#setState(s, s.approvals.size > 0 ? 'awaiting-approval' : 'working');
    return true;
  }

  close(id: string): void {
    const s = this.#sessions.get(id);
    if (!s) return;
    // Release anything the agent is blocked on, or the child never exits.
    for (const [, req] of s.approvals) req.respond({ outcome: 'cancelled' });
    s.approvals.clear();
    s.client.close();
    this.#sessions.delete(id);
    this.emit('session-list-changed');
  }

  closeAll(): void {
    for (const id of [...this.#sessions.keys()]) this.close(id);
    for (const obs of this.#observed.values()) obs.observer.stop();
    this.#observed.clear();
  }

  /* ─── observed sessions (started by hand in a terminal) ───────────────── */

  /**
   * Sessions Grok persisted to disk, including ones this daemon never started.
   * Read-only — we surface them so installing grokrc doesn't change how you work.
   */
  async discoverOnDisk(limit = 50): Promise<SessionInfo[]> {
    const root = join(GROK_HOME, 'sessions');
    const out: SessionInfo[] = [];
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return out;
    }

    for (const encodedCwd of dirs) {
      const cwd = safeDecode(encodedCwd);
      const cwdDir = join(root, encodedCwd);
      let ids: string[];
      try {
        if (!(await stat(cwdDir)).isDirectory()) continue;
        ids = await readdir(cwdDir);
      } catch {
        continue;
      }
      for (const id of ids) {
        try {
          const raw = await readFile(join(cwdDir, id, 'summary.json'), 'utf8');
          const s = JSON.parse(raw) as SummaryFile;
          // Field names verified against real session files — Grok writes
          // `session_summary` and `current_model_id`, not `title`/`model`.
          out.push({
            id: s.info?.id ?? id,
            cwd: s.info?.cwd ?? cwd,
            title: s.session_summary || defaultTitle(cwd),
            model: s.current_model_id,
            mode: 'observed',
            state: 'idle',
            createdAt: toMs(s.created_at),
            updatedAt: toMs(s.updated_at),
            pendingApprovals: 0,
          });
        } catch {
          // Not every directory has a readable summary (partial writes, subagents).
        }
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** Sessions with a live process right now, per Grok's own registry. */
  async activeOnDisk(): Promise<{ sessionId: string; pid: number; cwd: string }[]> {
    try {
      const raw = await readFile(join(GROK_HOME, 'active_sessions.json'), 'utf8');
      const arr = JSON.parse(raw) as { session_id: string; pid: number; cwd: string }[];
      return arr.map((a) => ({ sessionId: a.session_id, pid: a.pid, cwd: a.cwd }));
    } catch {
      return [];
    }
  }

  /* ─── internals ───────────────────────────────────────────────────────── */

  #require(id: string): LiveSession {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`no such session: ${id}`);
    return s;
  }

  #wire(s: LiveSession): void {
    s.client.on('session-update', (params) => {
      for (const ev of normalizeSessionUpdate(params)) {
        // Coalesce streamed chunks so reconnecting clients replay whole
        // messages instead of thousands of one-token fragments. Thinking
        // streams the same way text does — missing that made every thought
        // token render as its own block.
        // The agent echoes the prompt back as `user_message_chunk`. We already
        // recorded it in prompt(), so honouring the echo shows every message
        // twice. Observed sessions are the opposite case — there the echo is
        // the ONLY source of the user's messages, so it must be kept.
        if (ev.k === 'text' && ev.role === 'user') continue;

        let streamKind: 'text' | 'thinking' | null = null;
        let chunk = '';
        if (ev.k === 'thinking') {
          streamKind = 'thinking';
          chunk = ev.text;
        } else if (ev.k === 'text' && ev.role === 'agent' && !ev.final) {
          streamKind = 'text';
          chunk = ev.text;
        }

        if (streamKind) {
          if (s.stream && s.stream.kind !== streamKind) this.#flush(s);
          s.stream = { kind: streamKind, text: (s.stream?.text ?? '') + chunk };
          this.emit('event', ev); // live clients still get the token stream
          s.info.updatedAt = Date.now();
          continue;
        }

        // Only genuinely interrupting content ends a streamed message. Metadata
        // — status ticks, command lists, mode changes, unknown passthrough —
        // arrives mid-stream constantly, and flushing on it chopped a single
        // reply into several bubbles.
        if (INTERRUPTS_STREAM.has(ev.k)) this.#flush(s);
        this.#push(s, ev);
      }
    });

    s.client.on('permission', (req: PermissionRequest) => {
      this.#flush(s);
      const requestId = randomUUID();
      s.approvals.set(requestId, req);
      this.#push(s, normalizePermission(requestId, req.params));
      this.#setState(s, 'awaiting-approval');
    });

    s.client.on('error', (err: Error) => {
      this.#push(s, { k: 'error', sessionId: s.info.id, message: err.message, fatal: false });
    });

    s.client.on('protocol-drift', (err: Error) => {
      this.#push(s, { k: 'error', sessionId: s.info.id, message: err.message, fatal: false });
    });

    s.client.on('close', () => {
      for (const [, req] of s.approvals) req.respond({ outcome: 'cancelled' });
      s.approvals.clear();
      this.#push(s, {
        k: 'error',
        sessionId: s.info.id,
        message: 'agent process exited',
        fatal: true,
      });
      this.#sessions.delete(s.info.id);
      this.emit('session-list-changed');
    });
  }

  /** Emit whatever is currently streaming as one finished block. */
  #flush(s: LiveSession): void {
    const stream = s.stream;
    if (!stream?.text) {
      s.stream = null;
      return;
    }
    s.stream = null;
    this.#push(
      s,
      stream.kind === 'thinking'
        ? { k: 'thinking', sessionId: s.info.id, text: stream.text, final: true }
        : { k: 'text', sessionId: s.info.id, role: 'agent', text: stream.text, final: true }
    );
  }

  #push(s: LiveSession, ev: RcEvent): void {
    s.log.push(ev);
    if (s.log.length > EVENT_LOG_LIMIT) s.log.splice(0, s.log.length - EVENT_LOG_LIMIT);
    s.info.updatedAt = Date.now();
    this.emit('event', ev);
  }

  #setState(s: LiveSession, state: SessionState): void {
    if (s.info.state === state) return;
    s.info.state = state;
    this.#push(s, { k: 'status', sessionId: s.info.id, state });
  }
}

/** Shape of `~/.grok/sessions/<cwd>/<id>/summary.json`, verified against real files. */
interface SummaryFile {
  info?: { id?: string; cwd?: string };
  session_summary?: string;
  current_model_id?: string;
  created_at?: string;
  updated_at?: string;
  num_messages?: number;
}

function defaultTitle(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function toMs(v: unknown): number {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}
