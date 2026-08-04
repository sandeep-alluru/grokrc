/**
 * Terminal client — a real terminal on the SAME session your phone is driving.
 *
 * Why this exists: Grok's own TUI always runs its own agent. It cannot join a
 * shared leader (verified — the TUI never connects to `leader.sock`, and
 * `use_leader` appears nowhere in Grok's documentation), so terminal-and-phone
 * on one conversation is impossible through it.
 *
 * The fix sidesteps leader mode entirely. grokrc's daemon is ALREADY a shared
 * backend: it owns the agent, normalizes events, and holds pending approvals.
 * So this connects to the daemon over the very same WebSocket the phone uses.
 * Both clients see identical events, either can answer an approval, and neither
 * is privileged. No grok config changes, no leader process.
 *
 *   grokrc term                 # pick a session
 *   grokrc term --new           # start a fresh one
 *   grokrc term --session <id>
 */
import { createInterface, type Interface } from 'node:readline';
import { AuthStore, CONFIG_DIR } from '../daemon/auth.ts';
import type { RcEvent, SessionState } from '../daemon/events.ts';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const TOKEN_PATH = join(CONFIG_DIR, 'term-token');

/* ─── ANSI ────────────────────────────────────────────────────────────────── */

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2');
const bold = c('1');
const italic = c('3');
const blue = c('38;5;75');
const green = c('38;5;71');
const red = c('38;5;167');
const amber = c('38;5;179');

interface SessionInfo {
  id: string;
  cwd: string;
  title: string;
  mode: string;
  state: SessionState;
  pendingApprovals: number;
  externallyActive?: boolean;
}

export interface TerminalClientOptions {
  url?: string;
  sessionId?: string;
  newSession?: boolean;
  cwd?: string;
}

export class TerminalClient {
  #ws: import('ws').WebSocket | null = null;
  #rl: Interface | null = null;
  #opts: TerminalClientOptions;
  #sessions: SessionInfo[] = [];
  #current: SessionInfo | null = null;
  /** requestId → the approval awaiting an answer. */
  #pendingApproval: {
    requestId: string;
    options: { id: string; label: string; intent: string }[];
  } | null = null;
  /** True while the agent is mid-turn; the prompt is suppressed. */
  #busy = false;
  /** True while the session menu is open and awaiting a keystroke. */
  #choosing = false;
  /** Whether the last thing printed was streamed text, so we know to break the line. */
  #midStream = false;

  constructor(opts: TerminalClientOptions = {}) {
    this.#opts = opts;
  }

  async run(): Promise<void> {
    const token = await this.#localToken();
    const url = this.#opts.url ?? 'ws://127.0.0.1:4319';

    const { WebSocket } = await import('ws');
    const ws = new WebSocket(url);
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err: Error) =>
        reject(
          new Error(
            `cannot reach the grokrc daemon at ${url} — is it running? (systemctl --user status grokrc)\n  ${err.message}`
          )
        )
      );
    });

    ws.on('message', (raw: Buffer) => this.#onMessage(raw.toString()));
    ws.on('close', () => {
      console.log(dim('\n  daemon disconnected'));
      process.exit(0);
    });

    this.#send({ t: 'hello', token });
  }

  /**
   * Reuse a stored local token, or mint one. No pairing code: this process runs
   * as the same user as the daemon (see AuthStore.mintLocalDevice).
   */
  async #localToken(): Promise<string> {
    try {
      const existing = (await readFile(TOKEN_PATH, 'utf8')).trim();
      if (existing) return existing;
    } catch {
      /* first run */
    }
    const auth = new AuthStore();
    await auth.load();
    const { token } = await auth.mintLocalDevice(`terminal (${process.env.USER ?? 'local'})`);
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await writeFile(TOKEN_PATH, token, { mode: 0o600 });
    return token;
  }

  #send(payload: unknown): void {
    if (this.#ws?.readyState === 1) this.#ws.send(JSON.stringify(payload));
  }

  /* ─── inbound ───────────────────────────────────────────────────────────── */

  #onMessage(raw: string): void {
    let msg: { t: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.t) {
      case 'ready':
        this.#send({ t: 'sessions' });
        return;

      case 'sessions':
        this.#sessions = msg.sessions as SessionInfo[];
        // The daemon re-broadcasts this whenever the session list changes, which
        // happens while we're still waiting on the user's choice — without the
        // `#choosing` guard the menu reprints on top of the prompt.
        if (!this.#current && !this.#choosing) void this.#chooseSession();
        return;

      case 'created':
      case 'resumed':
        this.#current = msg.session as SessionInfo;
        console.log(green(`\n  ● ${this.#current.title}`) + dim(`  ${this.#current.cwd}\n`));
        this.#send({ t: 'open', sessionId: this.#current.id, cwd: this.#current.cwd });
        this.#startInput();
        return;

      case 'history': {
        const events = msg.events as RcEvent[];
        for (const ev of events) this.#render(ev, true);
        return;
      }

      case 'event':
        this.#render(msg.event as RcEvent, false);
        return;

      case 'error':
        console.log(red(`\n  error: ${String(msg.message)}`));
        return;
    }
  }

  /* ─── session selection ─────────────────────────────────────────────────── */

  async #chooseSession(): Promise<void> {
    if (this.#opts.newSession) {
      this.#send({ t: 'create', cwd: this.#opts.cwd });
      return;
    }
    if (this.#opts.sessionId) {
      const s = this.#sessions.find((x) => x.id.startsWith(this.#opts.sessionId!));
      if (!s) {
        console.error(red(`  no session matching ${this.#opts.sessionId}`));
        process.exit(1);
      }
      this.#openOrResume(s);
      return;
    }

    const live = this.#sessions.filter((s) => s.mode !== 'observed');
    const past = this.#sessions.filter((s) => s.mode === 'observed');
    const shown = [...live, ...past].slice(0, 12);

    console.log(bold('\n  grokrc — sessions\n'));
    console.log(dim('   0) + new session'));
    shown.forEach((s, i) => {
      const tag = s.externallyActive
        ? amber('live in terminal')
        : s.mode === 'observed'
          ? dim('past')
          : green(s.state);
      const badge = s.pendingApprovals ? amber(` ${s.pendingApprovals} waiting`) : '';
      console.log(
        `  ${String(i + 1).padStart(2)}) ${s.title.slice(0, 46).padEnd(48)} ${tag}${badge}`
      );
    });

    this.#choosing = true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((res) => rl.question(dim('\n  choose: '), res));
    rl.close();
    this.#choosing = false;

    const n = Number(answer.trim());
    if (!Number.isInteger(n) || n < 0 || n > shown.length) {
      console.error(red('  invalid choice'));
      process.exit(1);
    }
    if (n === 0) {
      this.#send({ t: 'create', cwd: this.#opts.cwd });
      return;
    }
    this.#openOrResume(shown[n - 1]!);
  }

  #openOrResume(s: SessionInfo): void {
    // A past session must be taken live before it will accept input; an owned
    // one is already ours.
    if (s.mode === 'observed') this.#send({ t: 'resume', sessionId: s.id, cwd: s.cwd });
    else {
      this.#current = s;
      console.log(green(`\n  ● ${s.title}`) + dim(`  ${s.cwd}\n`));
      this.#send({ t: 'open', sessionId: s.id, cwd: s.cwd });
      this.#startInput();
    }
  }

  /* ─── rendering ─────────────────────────────────────────────────────────── */

  #render(ev: RcEvent, replaying: boolean): void {
    switch (ev.k) {
      case 'text': {
        if (ev.role === 'user') {
          this.#breakStream();
          console.log(blue(`\n  › ${ev.text}`));
          return;
        }
        // Stream tokens inline; the coalesced `final` block would duplicate what
        // was already printed, so it is skipped live and used only on replay.
        if (!ev.final) {
          if (!this.#midStream) process.stdout.write('\n  ');
          process.stdout.write(ev.text.replace(/\n/g, '\n  '));
          this.#midStream = true;
        } else if (replaying) {
          console.log('\n  ' + ev.text.replace(/\n/g, '\n  '));
        } else {
          this.#breakStream();
        }
        return;
      }

      case 'thinking':
        // Only the finished block, and only when replaying — streaming every
        // reasoning token would drown the actual answer.
        if (replaying && ev.final) {
          console.log(dim(italic(`\n  ${ev.text.slice(0, 300).replace(/\n/g, ' ')}`)));
        }
        return;

      case 'tool': {
        this.#breakStream();
        const mark = ev.status === 'ok' ? green('✓') : ev.status === 'error' ? red('✗') : dim('•');
        console.log(`  ${mark} ${dim(ev.title ?? ev.name)}`);
        return;
      }

      case 'plan':
        this.#breakStream();
        for (const it of ev.items) {
          const done = /complete|done/i.test(it.status);
          console.log(dim(`    ${done ? '✓' : '○'} ${it.text}`));
        }
        return;

      case 'approval':
        this.#breakStream();
        this.#promptApproval(ev);
        return;

      case 'approval-resolved':
        if (this.#pendingApproval?.requestId === ev.requestId) this.#pendingApproval = null;
        return;

      case 'status':
        this.#busy = ev.state === 'working' || ev.state === 'thinking';
        if (!this.#busy) this.#breakStream();
        return;

      case 'error':
        this.#breakStream();
        console.log(red(`  ${ev.message}`));
        return;
    }
  }

  #breakStream(): void {
    if (this.#midStream) {
      process.stdout.write('\n');
      this.#midStream = false;
    }
  }

  /* ─── approvals ─────────────────────────────────────────────────────────── */

  #promptApproval(ev: Extract<RcEvent, { k: 'approval' }>): void {
    this.#pendingApproval = { requestId: ev.requestId, options: ev.options };

    console.log(amber(`\n  ⚠ ${ev.title}`));
    if (ev.input !== undefined && ev.input !== null) {
      const body = typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input, null, 2);
      console.log(dim('    ' + body.slice(0, 500).replace(/\n/g, '\n    ')));
    }
    // Narrow grants first — the agent lists the broadest option first, and a
    // reflex keypress should not hand over the whole session.
    const ordered = [...ev.options].sort((a, b) => rank(a) - rank(b));
    this.#pendingApproval.options = ordered;
    ordered.forEach((o, i) => {
      const paint = o.intent === 'allow' ? green : o.intent === 'deny' ? red : dim;
      console.log(`    ${i + 1}) ${paint(o.label)}`);
    });
    console.log(dim('\n  (your phone can answer this too — whoever gets there first wins)'));
    process.stdout.write(amber('  approve: '));
  }

  /* ─── input ─────────────────────────────────────────────────────────────── */

  #startInput(): void {
    if (this.#rl) return;
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
    this.#rl = rl;

    console.log(dim('  type a message and press enter · /q to quit · ctrl-c to cancel a turn\n'));

    rl.on('line', (line) => {
      const text = line.trim();

      // An outstanding approval takes priority over anything else typed.
      if (this.#pendingApproval) {
        const n = Number(text);
        const opt = this.#pendingApproval.options[n - 1];
        if (!opt) {
          process.stdout.write(amber('  approve: '));
          return;
        }
        this.#send({
          t: 'approve',
          sessionId: this.#current?.id,
          requestId: this.#pendingApproval.requestId,
          optionId: opt.id,
        });
        console.log(dim(`  → ${opt.label}`));
        this.#pendingApproval = null;
        return;
      }

      if (!text) return;
      if (text === '/q' || text === '/quit') {
        console.log(dim('  bye'));
        process.exit(0);
      }
      this.#send({ t: 'prompt', sessionId: this.#current?.id, text });
    });

    // Ctrl-C cancels the running turn rather than killing the client — the phone
    // may still be watching this session.
    rl.on('SIGINT', () => {
      if (this.#busy && this.#current) {
        this.#send({ t: 'cancel', sessionId: this.#current.id });
        console.log(dim('\n  cancelled'));
      } else {
        console.log(dim('\n  bye'));
        process.exit(0);
      }
    });
  }
}

function rank(o: { intent: string; kind?: string }): number {
  if (o.intent === 'allow' && o.kind === 'allow_once') return 0;
  if (o.intent === 'allow') return 1;
  if (o.intent === 'deny') return 2;
  return 3;
}
