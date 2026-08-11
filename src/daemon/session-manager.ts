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
import { isAbsolute, join } from 'node:path';
import { AcpClient, type PermissionRequest } from '../acp/client.ts';
import { StdioTransport, type Transport } from '../acp/transport.ts';
import { SessionObserver } from './observer.ts';
import { isStrictlyInside } from '../paths.ts';
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
 * Ceiling on concurrently owned agents. Each is a real grok process with its own
 * memory and model context, so this is a resource guard, not a policy.
 */
const MAX_LIVE_SESSIONS = 12;

/** Ceiling on mirrored sessions — tailers are cheap but not free. */
const MAX_OBSERVED_SESSIONS = 24;
/** How much of a dead session's stream to keep for recovery, and for how many. */
const RETAINED_EVENTS = 400;
const RETAINED_SESSIONS = 8;

/**
 * Event kinds that genuinely interrupt a streamed message and so should close
 * it off. Everything else (status, commands, mode, raw, approval-resolved) is
 * metadata that interleaves freely and must NOT split the message.
 */
const INTERRUPTS_STREAM = new Set<RcEvent['k']>(['tool', 'plan', 'approval', 'error']);

/**
 * Session ids come from a remote client and become a filesystem path segment,
 * so they are validated rather than trusted. Grok issues UUIDs; this accepts
 * that shape plus a little slack, and nothing containing a separator or a dot.
 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function assertSafeSessionId(id: string): void {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
    throw new Error(`invalid session id: ${JSON.stringify(String(id).slice(0, 40))}`);
  }
}

export interface ActiveSession {
  sessionId: string;
  pid: number;
  cwd: string;
  /**
   * The owning process is a shared `grok agent leader`, so another client may
   * safely join the SAME backend. A standalone TUI is not joinable — attaching
   * would create a second, independent agent on one conversation.
   */
  leaderHosted: boolean;
}

/**
 * Is this pid a shared leader?
 *
 * Asking whether *our daemon* runs with --leader is the wrong question: a
 * session started before leader mode was enabled still belongs to a standalone
 * agent. The only thing that makes joining safe is the OWNING process being a
 * leader, so that is what gets checked.
 */
async function isLeaderProcess(pid: number): Promise<boolean> {
  const args = await processArgs(pid);
  // 'unknown' fails this test too — an unverifiable process is not a leader.
  return args !== null && args !== ARGS_UNKNOWN && /\bagent\s+leader\b/.test(args);
}

/**
 * The full command line of a pid.
 *
 *   string      the argv, read successfully
 *   null        the process is GONE — `ps` ran and found nothing
 *   'unknown'   `ps` could not be run at all, so nothing was learned
 *
 * The third case used to collapse into `null`, and that was dangerous rather
 * than merely imprecise: takeOver reads `null` as "died between the registry
 * read and now — nothing to stop" and resumes WITHOUT killing the old agent. On
 * Windows there is no `ps`, so every takeover would have skipped the safety
 * check and put two agents on one conversation — the exact thing resume()
 * exists to refuse. "I could not look" is not "it is dead".
 */
export const ARGS_UNKNOWN = 'unknown';

/** Windows has no `ps`, and no argv[0] to read. See {@link processArgs}. */
const IS_WINDOWS = process.platform === 'win32';

/**
 * Windows: the EXECUTABLE PATH of a pid, via the process table.
 *
 * Returns the path alone — never a command line — because Windows does not
 * offer a trustworthy argv[0] the way `ps` does, and because a joined command
 * line cannot be split back apart: `C:\Program Files\grok\grok.exe agent stdio`
 * has no unambiguous boundary between the program and its first argument, and
 * `Program Files` is the normal install location.
 *
 * The three answers are kept distinct, because collapsing them is what made the
 * original bug dangerous:
 *   · a path        the process is there and identified
 *   · null          the process table has no such pid — it is GONE
 *   · ARGS_UNKNOWN  it exists but could not be identified, or we could not look
 *
 * A protected process reports an empty ExecutablePath. That is "I could not
 * look", not "it is dead", so it maps to ARGS_UNKNOWN and takeOver refuses.
 */
async function windowsExecutablePath(pid: number): Promise<string | null> {
  // `pid` is interpolated into a WQL filter. It reaches here from Grok's
  // on-disk registry, so it is validated as an integer rather than trusted.
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
    `if ($null -eq $p) { 'GONE' } else { 'EXE:' + $p.ExecutablePath }`;

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true }
    );
    const out = stdout.trim();
    if (out === 'GONE') return null;
    if (!out.startsWith('EXE:')) return ARGS_UNKNOWN;
    const path = out.slice('EXE:'.length).trim();
    return path === '' ? ARGS_UNKNOWN : path;
  } catch {
    // PowerShell missing, blocked by policy, or the query failed. Every one of
    // those means we learned nothing — which must never read as "it is dead".
    return ARGS_UNKNOWN;
  }
}

/**
 * How a pid identifies itself.
 *
 *   string      the argv (POSIX) or the executable path (Windows)
 *   null        the process is GONE — the process table was read and it is absent
 *   'unknown'   it could not be read at all, so nothing was learned
 *
 * The third case used to collapse into `null`, and that was dangerous rather
 * than merely imprecise: takeOver reads `null` as "died between the registry
 * read and now — nothing to stop" and resumes WITHOUT killing the old agent. On
 * Windows there was no `ps`, so every takeover skipped the safety check and put
 * two agents on one conversation — the exact thing resume() exists to refuse.
 * "I could not look" is not "it is dead".
 *
 * The two platforms return DIFFERENT SHAPES, and callers must not guess which:
 * a POSIX command line is matched with {@link looksLikeGrok}, a Windows
 * executable path with {@link looksLikeGrokExe}. See takeOver.
 */
export async function processArgs(pid: number): Promise<string | null> {
  if (IS_WINDOWS) return windowsExecutablePath(pid);
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('ps', ['-o', 'args=', '-p', String(pid)]);
    const line = stdout.trim();
    return line === '' ? null : line;
  } catch (err) {
    // ENOENT means the `ps` BINARY is missing — a stripped container. A
    // non-zero exit means ps ran and the pid was not there.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? ARGS_UNKNOWN : null;
  }
}

/**
 * Does this command line belong to a Grok process?
 *
 * Guards the ONE operation in grokrc that kills something: taking over a session
 * a terminal owns. Grok's `active_sessions.json` can name a pid that has since
 * died and been RECYCLED by the OS onto an unrelated program — `process.kill(pid, 0)`
 * says "alive" for any process at all. Without this check, a stale registry entry
 * plus an unlucky pid reuse means a tap on a phone kills something arbitrary.
 *
 * Only argv[0] is trusted. Matching "grok" anywhere would accept `vim grok.md`.
 */
export function looksLikeGrok(args: string): boolean {
  const argv0 = args.trim().split(/\s+/)[0] ?? '';
  return looksLikeGrokExe(argv0);
}

/**
 * Does this EXECUTABLE PATH belong to Grok?
 *
 * The same question as {@link looksLikeGrok}, asked of a path that is known to
 * be a path — no command line, no arguments, so no whitespace to interpret.
 * That distinction is the whole reason this exists.
 *
 * docs/WINDOWS-HANDOVER.md §3.1 proposed fixing the Windows case by having
 * `processArgs` return "the executable path alone", and states that "with a
 * clean path and no arguments, the existing separator handling already works".
 * MEASURED, and that is wrong: `looksLikeGrok` takes argv[0] by splitting on
 * whitespace FIRST, so the clean path `C:\Program Files\grok\grok.exe` still
 * reduces to `C:\Program` and a genuine agent is still rejected. Returning the
 * bare path is necessary and not sufficient — the predicate has to stop
 * splitting too, which it can only do safely when it knows there are no
 * arguments to split off.
 *
 * Splitting on BOTH separators matters: on '/' alone a Windows path stays
 * intact and never equals `grok.exe`.
 */
export function looksLikeGrokExe(exePath: string): boolean {
  const base = exePath.trim().split(/[/\\]/).pop() ?? '';
  return base === 'grok' || base === 'grok.exe';
}

/**
 * The directory has to still be there.
 *
 * Node reports a missing `cwd` as `spawn <cmd> ENOENT` — indistinguishable from
 * a missing binary, and the reason two production crashes were first misread as
 * "grok is not on the PATH". Sessions outlive the directories they ran in, so
 * every deleted project is a session in the list that cannot be resumed.
 */
async function assertCwdExists(cwd: string): Promise<void> {
  try {
    if (!(await stat(cwd)).isDirectory()) {
      throw new Error(`working directory is not a directory: ${cwd}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('working directory')) throw err;
    throw new Error(`working directory no longer exists: ${cwd}`, { cause: err });
  }
}

/**
 * cwd becomes a path segment and a process spawn directory.
 *
 * The test is "absolute", and it was written as `startsWith('/')` — which is
 * absolute only on POSIX. On Windows every real path is `C:\...`, so this
 * rejected EVERY directory on the machine: create, resume, observe and takeOver
 * all call it, so no session could be created, resumed, mirrored or taken over
 * on Windows at all. Measured: node's own `path.isAbsolute` returned true for
 * the same path this threw on.
 *
 * `isAbsolute` is the platform's own answer and keeps the property the check
 * exists for — a relative path from a remote client is still refused, and so is
 * a Windows drive-RELATIVE path like `C:foo`, which is not absolute despite the
 * drive letter.
 */
function assertSafeCwd(cwd: string): void {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error(
      `cwd must be an absolute path, got ${JSON.stringify(String(cwd).slice(0, 60))}`
    );
  }
}

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
  /**
   * A process outside this daemon currently owns the session — typically a TUI
   * running in a terminal. Resuming it would put a SECOND agent on the same
   * session, so the UI must offer watching only.
   */
  externallyActive?: boolean;
  /**
   * The owning process is a shared leader, so this daemon can attach to the SAME
   * backend. Distinct from `externallyActive`: a session can be live elsewhere
   * and still not be joinable — which is true of anything started before leader
   * mode was turned on.
   */
  joinable?: boolean;
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
  /** True until the observer has replayed the existing file. */
  catchingUp: boolean;
  log: RcEvent[];
  /** Chunk run being accumulated — mirrors LiveSession.stream. */
  stream: { kind: 'text' | 'thinking'; text: string } | null;
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

  /**
   * True when agents share one `grok agent leader` backend. It changes what the
   * UI may offer: a session another process owns can be JOINED (same backend)
   * rather than only watched.
   */
  get leaderMode(): boolean {
    return this.#opts.useLeader === true;
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
    assertSafeSessionId(id);
    assertSafeCwd(cwd);

    const existing = this.#observed.get(id);
    if (existing) {
      existing.watchers++;
      return { ...existing.info };
    }

    if (this.#observed.size >= MAX_OBSERVED_SESSIONS) {
      throw new Error(
        `too many observed sessions (${this.#observed.size}/${MAX_OBSERVED_SESSIONS})`
      );
    }

    const sessionsRoot = join(GROK_HOME, 'sessions');
    const dir = join(sessionsRoot, encodeURIComponent(cwd), id);
    // Belt and braces: even with both inputs validated, confirm the resolved
    // path never escapes the session store.
    if (!isStrictlyInside(sessionsRoot, dir)) {
      throw new Error('invalid session id: resolved outside the session store');
    }
    const now = Date.now();
    const obs: ObservedSession = {
      // Replayed history must not be broadcast as if it were live — see the
      // emit guard below. Cleared when the observer reaches the file's tail.
      catchingUp: true,
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
      stream: null,
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

    /** Same stream/flush model as owned sessions, so replay yields whole blocks. */
    const flushObserved = () => {
      const stream = obs.stream;
      if (!stream?.text) {
        obs.stream = null;
        return;
      }
      obs.stream = null;
      this.#pushObserved(
        obs,
        stream.kind === 'thinking'
          ? { k: 'thinking', sessionId: id, text: stream.text, final: true }
          : { k: 'text', sessionId: id, role: 'agent', text: stream.text, final: true }
      );
    };

    obs.observer.on('event', (ev) => {
      let streamKind: 'text' | 'thinking' | null = null;
      let chunk = '';
      if (ev.k === 'thinking' && !ev.final) {
        streamKind = 'thinking';
        chunk = ev.text;
      } else if (ev.k === 'text' && ev.role === 'agent' && !ev.final) {
        streamKind = 'text';
        chunk = ev.text;
      }

      if (streamKind) {
        if (obs.stream && obs.stream.kind !== streamKind) flushObserved();
        obs.stream = { kind: streamKind, text: (obs.stream?.text ?? '') + chunk };
        this.emit('event', { ...ev, sessionId: id });
        return;
      }

      if (INTERRUPTS_STREAM.has(ev.k)) flushObserved();
      this.#pushObserved(obs, { ...ev, sessionId: id } as RcEvent);
    });

    // Reaching the end of the log flushes whatever was still streaming —
    // otherwise a log ending mid-message loses that message entirely.
    obs.observer.on('idle', () => {
      obs.catchingUp = false; // caught up: events are real-time now
      flushObserved();
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
    // Do NOT broadcast the initial catch-up. Starting an observer replays
    // the whole of updates.jsonl; emitting each replayed line as a live
    // event pushed ~1518 frames (~10 MB) at a phone BEFORE the trimmed
    // history frame was sent, and killed the page. The breadcrumbs stop
    // between `open-session` and `history-received` — exactly this window.
    // Nothing is lost: replayed events are already in obs.log, and the
    // history frame carries the trimmed tail.
    if (!obs.catchingUp) this.emit('event', ev);
  }

  /* ─── lifecycle ───────────────────────────────────────────────────────── */

  async create(cwd: string, opts: { title?: string; model?: string } = {}): Promise<SessionInfo> {
    // Same boundary as resume(): cwd becomes a process spawn directory, and it
    // arrives from a remote client. Validating one path and not the other is
    // how a hole survives a security pass.
    assertSafeCwd(cwd);
    await assertCwdExists(cwd);

    // Each session is a live grok process. Without a ceiling, a client looping
    // on `create` forks agents until the machine falls over — cheap to trigger,
    // even post-auth.
    if (this.#sessions.size >= MAX_LIVE_SESSIONS) {
      throw new Error(
        `too many live sessions (${this.#sessions.size}/${MAX_LIVE_SESSIONS}) — close one first`
      );
    }

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

  /**
   * Reopen a persisted session as a LIVE, writable one.
   *
   * Observed mode only ever mirrors a log, so a session you started earlier
   * became permanently read-only once its process ended — you could read it but
   * never continue it. Grok advertises `loadSession: true`, so the agent can
   * genuinely resume it; `session/load` replays the conversation back to us as
   * session/update notifications, which is why wiring happens before the call.
   */
  async resume(id: string, cwd: string, opts: { model?: string } = {}): Promise<SessionInfo> {
    assertSafeSessionId(id);
    assertSafeCwd(cwd);
    await assertCwdExists(cwd);

    const existing = this.#sessions.get(id);
    if (existing) return { ...existing.info, pendingApprovals: existing.approvals.size };

    // Resume spawns an agent with `cwd` as its working directory. Requiring the
    // session to already exist on disk bounds that to somewhere grok has
    // actually run, instead of letting a client name any directory on the box.
    const dir = join(GROK_HOME, 'sessions', encodeURIComponent(cwd), id);
    try {
      if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error(`no persisted session ${id} under ${cwd}`);
    }

    // Attaching to a session another process owns is only dangerous WITHOUT a
    // shared leader: two independent agents on one conversation, each blind to
    // the other's writes. With `--leader` they are the same backend, so joining
    // is the intended behaviour — that is the whole point of leader mode.
    // Joining is safe only when the OWNING process is a shared leader — then it
    // is the same backend, which is the point of leader mode. A standalone TUI
    // (including any session started before leader mode was enabled) is not
    // joinable: a second agent on one conversation corrupts it.
    const owner = (await this.activeOnDisk()).find((a) => a.sessionId === id);
    if (owner && !(owner.leaderHosted && this.#opts.useLeader)) {
      throw new Error(
        `session ${id} is live in a standalone process (pid ${owner.pid}) — watch it read-only, ` +
          `or close it and reopen with a shared leader to drive it from here`
      );
    }

    // Stop mirroring — we're about to own it.
    const obs = this.#observed.get(id);
    if (obs) {
      obs.observer.stop();
      this.#observed.delete(id);
    }

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

    if (!client.capabilities?.loadSession) {
      client.close();
      throw new Error('this agent build cannot resume sessions (no loadSession capability)');
    }

    const now = Date.now();
    const session: LiveSession = {
      info: {
        id,
        cwd,
        title: obs?.info.title ?? defaultTitle(cwd),
        model,
        mode: this.#opts.useLeader ? 'shared' : 'owned',
        state: 'idle',
        createdAt: obs?.info.createdAt ?? now,
        updatedAt: now,
        pendingApprovals: 0,
      },
      client,
      // Keep anything already mirrored so the transcript doesn't blank out.
      log: obs?.log ?? [],
      approvals: new Map(),
      stream: null,
    };
    this.#sessions.set(id, session);
    this.#wire(session); // before load, so the replayed history is captured

    try {
      await client.loadSession(id, cwd);
      // Grok writes a turn to updates.jsonl when the turn COMPLETES. An agent
      // stopped mid-flight never writes its tail, so the replay above can be
      // missing text the user already watched arrive — and Take over stops the
      // agent mid-flight by design. Put back only what is genuinely absent;
      // duplicating a transcript would be worse than losing its tail.
      const lost = this.#recoverLostTail(id, session.log);
      if (lost.length) {
        session.log.unshift(...lost);
        console.log(`  recovered ${lost.length} event(s) the agent never persisted (${id})`);
      }
      this.#retained.delete(id);
    } catch (err) {
      this.#sessions.delete(id);
      client.close();
      throw err;
    }

    this.#flush(session);
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
    // FLUSH FIRST. Streaming text is coalesced in `s.stream` and only reaches
    // `s.log` when the stream ends — so a turn stopped mid-flight leaves the
    // text the user watched arrive sitting in a buffer that is about to be
    // dropped. That, not Grok's persistence, is where the tail was actually
    // lost: `loadSession` cannot replay what the agent never finished writing,
    // and we were discarding our own copy at the same moment.
    this.#flush(s);
    this.#retainLog(id, s.log);
    // Release anything the agent is blocked on, or the child never exits.
    for (const [, req] of s.approvals) req.respond({ outcome: 'cancelled' });
    s.approvals.clear();
    s.client.close();
    this.#sessions.delete(id);
    this.emit('session-list-changed');
  }

  /**
   * Events witnessed for a session that is no longer live, kept so a resume can
   * recover a turn the agent never persisted. Bounded: this is a short-lived
   * safety net, not a second transcript store.
   */
  #retained = new Map<string, RcEvent[]>();

  #retainLog(id: string, log: RcEvent[]): void {
    if (!log.length) return;
    this.#retained.set(id, log.slice(-RETAINED_EVENTS));
    // Oldest out first, so a long-running daemon cannot grow without bound.
    while (this.#retained.size > RETAINED_SESSIONS) {
      const oldest = this.#retained.keys().next().value;
      if (oldest === undefined) break;
      this.#retained.delete(oldest);
    }
  }

  /**
   * Agent text the replay is missing but we watched arrive.
   *
   * Only genuinely-absent content is returned: if `loadSession` replayed the
   * turn properly there is nothing to add, and adding it anyway would duplicate
   * the transcript — a worse bug than the one being fixed.
   */
  #recoverLostTail(id: string, replayed: RcEvent[]): RcEvent[] {
    const retained = this.#retained.get(id);
    if (!retained?.length) return [];
    const seen = new Set(
      replayed.filter((e) => e.k === 'text').map((e) => (e as { text?: string }).text ?? '')
    );
    return retained.filter((e) => e.k === 'text' && !seen.has((e as { text?: string }).text ?? ''));
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

    // Which sessions another process still owns, and whether that process is a
    // shared leader (joinable) or standalone (watch-only).
    const active = await this.activeOnDisk();
    const activeById = new Map(active.map((a) => [a.sessionId, a]));

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
            externallyActive: activeById.has(s.info?.id ?? id),
            joinable: activeById.get(s.info?.id ?? id)?.leaderHosted ?? false,
          });
        } catch {
          // Not every directory has a readable summary (partial writes, subagents).
        }
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /**
   * Stop the terminal process that owns a session, then resume it here.
   *
   * The gap this closes: a session started with plain `grok` is visible on the
   * phone but read-only, and the only way to take it over was to stop the TUI by
   * hand — impossible when the whole point is that you are away from the machine.
   *
   * DESTRUCTIVE. It terminates a process the user did not start from here, so:
   *   · only a pid Grok's own registry names as the owner of THIS session
   *   · only if that pid still looks like a grok process (pid reuse, see looksLikeGrok)
   *   · SIGTERM only — never SIGKILL, which risks an unflushed updates.jsonl
   *
   * Returns the resumed session. If no process owns it, this is just a resume.
   */
  async takeOver(
    id: string,
    cwd: string,
    opts: { model?: string; waitMs?: number } = {}
  ): Promise<SessionInfo> {
    // Validate BEFORE signalling anything.
    assertSafeSessionId(id);
    assertSafeCwd(cwd);

    const owner = (await this.activeOnDisk()).find((a) => a.sessionId === id);
    if (!owner) return this.resume(id, cwd, opts);

    if (owner.pid === process.pid) {
      throw new Error('refusing to terminate the grokrc daemon itself');
    }

    const args = await processArgs(owner.pid);
    if (args === ARGS_UNKNOWN) {
      // Cannot verify what that pid is, so cannot safely kill it OR safely
      // assume it is gone. Refuse loudly rather than resume alongside a live
      // agent. Reachable on Windows, where there is no `ps`.
      throw new Error(
        `cannot verify pid ${owner.pid}: no \`ps\` available on this system, so grokrc ` +
          `cannot confirm the old agent is a grok process or that it has exited. ` +
          `Stop the session in its own terminal and try again.`
      );
    }
    if (args === null) {
      // ps ran and found nothing: it died between the registry read and now.
      return this.resume(id, cwd, opts);
    }
    // processArgs returns a command line on POSIX and an executable path on
    // Windows. Matching the wrong shape is how this check silently stops
    // working: a path is not a command line and must not be word-split.
    const identifiesAsGrok = IS_WINDOWS ? looksLikeGrokExe(args) : looksLikeGrok(args);
    if (!identifiesAsGrok) {
      throw new Error(
        `refusing to stop pid ${owner.pid}: it is not a grok process (${args.slice(0, 60)}). ` +
          `Grok's session registry is stale and the pid has been reused.`
      );
    }

    try {
      process.kill(owner.pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return this.resume(id, cwd, opts); // already gone
      throw new Error(`could not stop pid ${owner.pid}: ${(err as Error).message}`, { cause: err });
    }

    // Wait for it to actually exit. Resuming while the old agent is still
    // writing puts two agents on one conversation — the thing resume() refuses.
    const deadline = Date.now() + (opts.waitMs ?? 8_000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(owner.pid, 0);
      } catch {
        return this.resume(id, cwd, opts); // gone — safe to own it
      }
    }

    throw new Error(
      `pid ${owner.pid} did not exit after SIGTERM. Not escalating to SIGKILL — ` +
        `that risks losing the last message. Stop it in the terminal and retry.`
    );
  }

  /**
   * Apply settings that are read per-use rather than baked in at construction.
   *
   * `model` and `useLeader` are consulted when a session is CREATED, so a
   * running daemon can honour a change without a restart. Sessions already
   * open keep the transport they were started with — changing an agent's model
   * underneath a live conversation is not something a config edit should do.
   */
  applyConfig(next: { model?: string; useLeader?: boolean }): void {
    if ('model' in next) this.#opts.model = next.model;
    if (typeof next.useLeader === 'boolean') this.#opts.useLeader = next.useLeader;
  }

  /**
   * Sessions with a live process right now, per Grok's own registry.
   *
   * The registry can go stale if a process dies without cleaning up, so each
   * entry's pid is checked — a stale record would otherwise permanently mark a
   * finished session as un-resumable.
   */
  async activeOnDisk(): Promise<ActiveSession[]> {
    try {
      const raw = await readFile(join(GROK_HOME, 'active_sessions.json'), 'utf8');
      const arr = JSON.parse(raw) as { session_id: string; pid: number; cwd: string }[];
      const live = arr.filter((a) => {
        try {
          process.kill(a.pid, 0); // signal 0 = liveness probe, sends nothing
          return true;
        } catch {
          return false;
        }
      });
      return Promise.all(
        live.map(async (a) => ({
          sessionId: a.session_id,
          pid: a.pid,
          cwd: a.cwd,
          leaderHosted: await isLeaderProcess(a.pid),
        }))
      );
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
