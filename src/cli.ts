#!/usr/bin/env node
/**
 * grokrc — remote control for xAI's Grok Build CLI.
 *
 *   grokrc up [--port N] [--host H] [--leader] [--model M] [--cwd DIR]
 *   grokrc pair
 *   grokrc devices
 *   grokrc revoke <deviceId|--all>
 *   grokrc doctor
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AuthStore } from './daemon/auth.ts';
import {
  CONFIG_KEYS,
  coerceValue,
  configPath,
  isKnownKey,
  loadConfig,
  missingCwdNotice,
  saveConfig,
  validateConfig,
} from './daemon/config.ts';
import { ControlServer, ControlUnavailableError, controlRequest } from './daemon/control.ts';
import { checkPermissionPosture, posturteWarning } from './daemon/preflight.ts';
import { PushService } from './daemon/push.ts';
import { SessionManager } from './daemon/session-manager.ts';
import { RemoteControlServer } from './daemon/server.ts';

const execFileAsync = promisify(execFile);
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = resolve(PKG_ROOT, 'web');

interface Flags {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): { cmd: string; rest: string[]; flags: Flags } {
  const flags: Flags = {};
  const rest: string[] = [];
  let cmd = 'help';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) flags[a.slice(2)] = argv[++i]!;
      else flags[a.slice(2)] = true;
    } else if (cmd === 'help' && !rest.length) cmd = a;
    else rest.push(a);
  }
  return { cmd, rest, flags };
}

function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

const HELP = `
grokrc — remote control for Grok Build

  grokrc up          Start the daemon and serve the phone client
      --port <N>       Port (default 4319)
      --host <H>       Bind address (default 127.0.0.1 — loopback only)
      --lan            Bind 0.0.0.0 so other devices on your network can reach it
      --leader         Share one backend with a running grok TUI (laptop <-> phone handoff)
      --model <M>      Model override for new sessions
      --cwd <DIR>      Default working directory for new sessions
      --pair           Print a pairing code even if devices are already paired
      --history <N>    How many past sessions to list (default 10)
      --no-push        Disable Web Push (no VAPID keys, no subscriptions)
      --relay <URL>    Dial OUT to a relay — no inbound port, works on cellular
      --room <ID>      Relay room id (generated if omitted)
      --relay-key <K>  Relay room key (generated if omitted)

  grokrc relay       Run a self-hostable relay server
      --port <N>       Port (default 8080)

  grokrc term        Terminal client on the same session your phone drives
      --new            Start a new session
      --session <id>   Open a specific session
      --url <URL>      Daemon URL (default ws://127.0.0.1:4319)

  grokrc pair        Print a pairing code for a new device (needs a running daemon)
  grokrc config      Show settings  ·  config set <key> <value>  ·  config unset <key>
  grokrc devices     List paired devices
  grokrc revoke <id> Revoke a device  (--all to revoke everything)
  grokrc doctor      Check that grok is installed and ACP responds
`;

/**
 * The agent binary, or null when it is not installed.
 *
 * Shared by `doctor` and `up`: a daemon that cannot spawn an agent is not a
 * degraded daemon, it is a useless one. `up` used to start anyway, print a
 * config warning, and listen — so a new user paired a phone and only discovered
 * the problem when every session failed.
 */
async function findGrok(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('grok', ['--version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

const GROK_MISSING =
  '  \u2717 grok not found on PATH \u2014 install: curl -fsSL https://x.ai/cli/install.sh | bash';

async function cmdUp(flags: Flags): Promise<void> {
  // Before anything else. Starting without an agent means pairing a phone to a
  // daemon that cannot open a single session.
  const grokVersion = await findGrok();
  if (!grokVersion) {
    console.log('');
    console.log(GROK_MISSING);
    console.log('    grokrc drives Grok Build — it cannot start a session without it.');
    console.log('    After installing, sign in with:  grok login');
    console.log('');
    process.exitCode = 1;
    return;
  }

  // Settings are the durable answer; flags override for this invocation only.
  const cfg = await loadConfig();
  const issues = validateConfig(cfg);
  if (issues.length) {
    console.log(`\n  ⚠ problems in ${configPath()}:`);
    for (const i of issues) console.log(`      ${i.key}: ${i.message}`);
    console.log('');
    if (issues.some((i) => i.fatal)) process.exit(1);
  }

  const auth = new AuthStore();
  await auth.load();

  const push = new PushService();
  if (flags['no-push'] !== true) await push.load();

  const sessions = new SessionManager({
    model: typeof flags.model === 'string' ? flags.model : cfg.model,
    useLeader: flags.leader === true || cfg.leader === true,
  });

  const lan = flags.lan === true || cfg.lan === true;
  const host = lan ? '0.0.0.0' : ((flags.host as string) ?? cfg.host ?? '127.0.0.1');
  const port = Number(flags.port ?? cfg.port ?? 4319);

  // The one setting with no safe default — see config.ts.
  const defaultCwd =
    typeof flags.cwd === 'string' ? resolve(flags.cwd) : (cfg.defaultCwd ?? process.cwd());

  const server = new RemoteControlServer({
    host,
    port,
    webRoot: WEB_ROOT,
    sessions,
    auth,
    push: flags['no-push'] === true ? undefined : push,
    defaultCwd,
    historyLimit: flags.history !== undefined ? Number(flags.history) : cfg.historyLimit,
  });

  // Say so loudly if the agent will never ask for approval — otherwise the
  // headline feature silently does nothing and tools run unattended.
  const posture = await checkPermissionPosture();
  const warning = posturteWarning(posture);
  if (warning) console.log(warning);

  // No configured project directory means phone-created sessions land wherever
  // the process happens to be — under systemd, the user's home.
  if (!cfg.defaultCwd && typeof flags.cwd !== 'string') console.log(missingCwdNotice());

  const bound = await server.listen();
  const shown = host === '0.0.0.0' ? (lanAddress() ?? '0.0.0.0') : host;

  if (typeof flags.relay === 'string') {
    const room = typeof flags.room === 'string' ? flags.room : randomBytes(6).toString('hex');
    const key =
      typeof flags['relay-key'] === 'string' ? flags['relay-key'] : randomBytes(16).toString('hex');
    // base64url, matching web/crypto.js
    const secret = flags['no-e2e'] === true ? undefined : randomBytes(32).toString('base64url');

    server.connectRelay({ url: flags.relay, room, key, secret });

    const httpUrl = flags.relay.replace(/^ws/, 'http');
    // The secret goes in the FRAGMENT — browsers never send it to the relay.
    const frag = secret ? `#e=${secret}` : '';
    console.log(`\n  relay: ${flags.relay}`);
    console.log(`  phone URL: ${httpUrl}/client?room=${room}&key=${key}${frag}`);
    console.log('  (no inbound port needed — this machine dials out)');
    console.log(
      secret
        ? '  end-to-end encrypted: the secret is in the URL fragment, which the relay never receives'
        : '  ⚠ --no-e2e: the relay can read everything on this connection'
    );
  }

  console.log(`\n  grokrc listening on http://${shown}:${bound.port}`);
  if (host === '0.0.0.0') {
    console.log('  ⚠ bound to all interfaces — keep this on a trusted network or a Tailnet.');
  } else {
    console.log('  loopback only. Use --lan to reach it from your phone, or tunnel it.');
  }

  // Print a code when nothing is paired, or whenever --pair is asked for.
  // Without the second case, adding a SECOND device (you paired on the desktop,
  // now you want your phone) was impossible — the code lives in the running
  // daemon's memory and `grokrc pair` cannot reach it.
  if (auth.devices.length === 0 || flags.pair === true) {
    const { code } = auth.beginPairing();
    const lead =
      auth.devices.length === 0
        ? 'No paired devices. Open the URL above on your device and enter:'
        : `${auth.devices.length} device(s) already paired. To add another, enter:`;
    console.log(`\n  ${lead}\n`);
    console.log(`      ${code}\n`);
    console.log('  (valid 5 minutes, single use)');
  } else {
    console.log(
      `  ${auth.devices.length} paired device(s). Restart with \`--pair\` to add another.`
    );
  }
  console.log('');

  // The CLI's way in to this process. Without it `grokrc pair` can only ask you
  // to restart, which drops every live session to hand out six characters.
  const control = new ControlServer({
    pair: () => auth.beginPairing(),
    devices: () => {
      const live = server.connectedDeviceIds();
      return auth.devices.map((d) => ({
        id: d.id,
        name: d.name,
        pairedAt: d.pairedAt,
        lastSeen: d.lastSeen,
        connected: live.has(d.id),
      }));
    },
    revoke: async (id) => {
      const ok = await auth.revoke(id);
      // Revoking in the store alone leaves an already-connected phone driving
      // the agent until it happens to reconnect.
      if (ok) server.disconnectDevice(id);
      return ok;
    },
    revokeAll: async () => {
      const ids = auth.devices.map((d) => d.id);
      await auth.revokeAll();
      for (const id of ids) server.disconnectDevice(id);
      return ids.length;
    },
    status: () => ({
      pid: process.pid,
      host: shown,
      port: bound.port,
      devices: auth.devices.length,
      connected: server.connectedDeviceIds().size,
      sessions: sessions.list().length,
      push: push.subscriberCount,
    }),
  });

  try {
    await control.listen();
  } catch (err) {
    // A control channel that will not start must not stop the daemon serving
    // phones — it only costs you `grokrc pair` without a restart.
    console.log(`  ⚠ control socket unavailable: ${(err as Error).message}`);
  }

  const shutdown = async () => {
    console.log('\nshutting down…');
    sessions.closeAll();
    await control.close();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function cmdPair(): Promise<void> {
  try {
    const { code, expiresAt } = await controlRequest<{ code: string; expiresAt: number }>('pair');
    const mins = Math.max(0, Math.round((expiresAt - Date.now()) / 60_000));
    console.log(`\n  Enter this on the device you are pairing:\n`);
    console.log(`      ${code}\n`);
    console.log(`  (valid ${mins} minutes, single use)\n`);
  } catch (err) {
    if (!(err instanceof ControlUnavailableError)) {
      console.log(`\n  could not reach the daemon: ${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    // No daemon: a code minted here would live in a process that is about to
    // exit, and nothing could redeem it. Say that instead of printing one.
    console.log(
      '\n  No grokrc daemon is running — a code issued here could never be redeemed.\n' +
        '  Start one with `grokrc up`, then run `grokrc pair` again.\n'
    );
    process.exitCode = 1;
  }
}

async function cmdDevices(): Promise<void> {
  interface Row {
    id: string;
    name: string;
    pairedAt: number;
    lastSeen: number;
    connected: boolean;
  }

  let rows: Row[];
  let live = true;
  try {
    ({ devices: rows } = await controlRequest<{ devices: Row[] }>('devices'));
  } catch (err) {
    if (!(err instanceof ControlUnavailableError)) {
      console.log(`\n  could not reach the daemon: ${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    // No daemon — the store on disk still answers who is paired, just not who
    // is connected. Degrade rather than fail.
    const auth = new AuthStore();
    await auth.load();
    rows = auth.devices.map((d) => ({ ...d, connected: false }));
    live = false;
  }

  if (rows.length === 0) return console.log('\n  no paired devices\n');

  console.log('');
  for (const d of rows) {
    const dot = live ? (d.connected ? '●' : '○') : ' ';
    console.log(
      `  ${dot} ${d.id}  ${d.name.slice(0, 40).padEnd(40)}  paired ${new Date(d.pairedAt).toLocaleString()}  last seen ${new Date(d.lastSeen).toLocaleString()}`
    );
  }
  console.log(
    live
      ? '\n  ● connected now   ○ paired, not connected\n'
      : '\n  (no daemon running — connection state unknown)\n'
  );
}

async function cmdRevoke(rest: string[], flags: Flags): Promise<void> {
  const all = flags.all === true;
  const id = rest[0];
  if (!all && !id) return console.log('  usage: grokrc revoke <deviceId> | --all');

  try {
    const { revoked } = await controlRequest<{ revoked: number }>(
      'revoke',
      all ? { all: true } : { deviceId: id }
    );
    if (all) return console.log(`  revoked ${revoked} device(s); their sockets were closed`);
    console.log(revoked ? `  revoked ${id}; its socket was closed` : `  no such device: ${id}`);
  } catch (err) {
    if (!(err instanceof ControlUnavailableError)) {
      console.log(`\n  could not reach the daemon: ${(err as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    // No daemon: write to the store directly. Nothing is connected, so there
    // is no socket to close.
    const auth = new AuthStore();
    await auth.load();
    if (all) {
      await auth.revokeAll();
      return console.log('  all devices revoked');
    }
    console.log((await auth.revoke(id!)) ? `  revoked ${id}` : `  no such device: ${id}`);
  }
}

/**
 *   grokrc config                       show current settings
 *   grokrc config set <key> <value>
 *   grokrc config unset <key>
 */
async function cmdConfig(rest: string[]): Promise<void> {
  const cfg = await loadConfig();
  const [action, key, ...valueParts] = rest;

  if (!action || action === 'show' || action === 'list') {
    console.log(`\n  ${configPath()}\n`);
    if (Object.keys(cfg).length === 0) console.log('  (empty — nothing configured yet)');
    for (const k of CONFIG_KEYS) {
      const v = cfg[k];
      if (v !== undefined) console.log(`  ${k.padEnd(14)} ${JSON.stringify(v)}`);
    }
    if (!cfg.defaultCwd) console.log(missingCwdNotice());
    else console.log('');
    return;
  }

  if (action === 'set') {
    if (!key || !isKnownKey(key)) {
      console.log(`\n  unknown key: ${key ?? '(none)'}`);
      console.log(`  valid keys: ${CONFIG_KEYS.join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    const raw = valueParts.join(' ');
    if (!raw) {
      console.log(`\n  usage: grokrc config set ${key} <value>\n`);
      process.exitCode = 1;
      return;
    }
    // Resolve paths relative to where the user is standing, so `config set
    // defaultCwd .` does the obvious thing.
    const value = key === 'defaultCwd' ? resolve(raw) : coerceValue(key, raw);
    const next = { ...cfg, [key]: value };

    const issues = validateConfig(next);
    const bad = issues.find((i) => i.key === key);
    if (bad) {
      console.log(`\n  ${key} ${bad.message}: ${JSON.stringify(value)}\n`);
      process.exitCode = 1;
      return;
    }

    await saveConfig(next);
    console.log(`\n  ${key} = ${JSON.stringify(value)}`);
    console.log(`  saved to ${configPath()}`);
    console.log('  restart to apply:  systemctl --user restart grokrc\n');
    return;
  }

  if (action === 'unset') {
    if (!key || !isKnownKey(key)) {
      console.log(`\n  unknown key: ${key ?? '(none)'}\n`);
      process.exitCode = 1;
      return;
    }
    const next = { ...cfg };
    delete next[key];
    await saveConfig(next);
    console.log(`\n  ${key} unset\n`);
    return;
  }

  console.log('\n  usage: grokrc config [show | set <key> <value> | unset <key>]\n');
  process.exitCode = 1;
}

/**
 * Delete a session directory this process created.
 *
 * Only ever called with an id we just minted, and the path is re-derived the
 * same way the session manager builds it. Best-effort: a diagnostic failing to
 * tidy up must not fail the diagnostic.
 */
export async function removeSessionDir(sessionId: string, cwd: string): Promise<void> {
  try {
    const { rm } = await import('node:fs/promises');
    const { homedir } = await import('node:os');
    const grokHome = process.env.GROK_HOME ?? resolve(homedir(), '.grok');
    const dir = resolve(grokHome, 'sessions', encodeURIComponent(cwd), sessionId);
    // Refuse to delete anything that is not inside the session store.
    if (!dir.startsWith(resolve(grokHome, 'sessions') + '/')) return;
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Turn an agent error into an instruction, or null when there is nothing to add.
 *
 * The agent says "Authentication required (-32000)". True, and useless to
 * someone who has just installed this: it names no command.
 *
 * Exported and pure so it can be tested on a machine with no agent — the guard
 * for this control was UNPROVABLE on CI, because the only test that exercised
 * it needed a real `grok` on PATH and silently skipped itself. A skipped test
 * counts as a pass, so the guard reported "passes without the control".
 */
export function authHint(message: string): string | null {
  if (!/auth|unauthori[sz]ed|not logged in|-32000/i.test(message)) return null;
  return '      you are not signed in to Grok — run:  grok login';
}

async function cmdDoctor(): Promise<void> {
  console.log('');
  const grokVersion = await findGrok();
  if (!grokVersion) {
    console.log(GROK_MISSING);
    console.log('    after installing, sign in with:  grok login');
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ grok found: ${grokVersion}`);

  const { StdioTransport } = await import('./acp/transport.ts');
  const { AcpClient } = await import('./acp/client.ts');
  const client = new AcpClient({ transport: new StdioTransport({ cwd: process.cwd() }) });
  try {
    const init = await client.initialize();
    console.log(`  ✓ ACP handshake ok (protocolVersion ${init.protocolVersion})`);
    console.log(`    loadSession: ${init.agentCapabilities?.loadSession ?? false}`);
    console.log(
      `    auth methods: ${(init.authMethods ?? []).map((m) => m.id).join(', ') || 'none'}`
    );
    const s = await client.newSession(process.cwd());
    console.log(`  ✓ session/new ok (${s.sessionId})`);

    // Clean up after ourselves. `session/new` persists a directory under
    // ~/.grok/sessions, so every `doctor` run was leaving a junk session behind —
    // they accumulate in the phone's session list and push real work out of the
    // history cap. A diagnostic must not mutate the state it inspects.
    await removeSessionDir(s.sessionId, process.cwd());

    // Push is the feature most likely to be quietly broken — it depends on
    // HTTPS, a service worker, and a third-party push service, none of which
    // report back on their own.
    const pushSvc = new PushService();
    await pushSvc.load();
    const st = pushSvc.stats;
    console.log(
      `  · push: ${pushSvc.subscriberCount} subscriber(s), ` +
        `${st.sent} sent, ${st.failed} failed, ${st.expired} expired`
    );
    if (pushSvc.lastError) {
      console.log(`    last failure: ${pushSvc.lastError.message}`);
      console.log(`    endpoint: ${pushSvc.lastError.endpoint}`);
    }
    if (pushSvc.subscriberCount === 0) {
      console.log('    (no devices subscribed — open the app over HTTPS and allow notifications)');
    }

    const posture = await checkPermissionPosture();
    if (posture.willPrompt) {
      console.log('  ✓ agent will prompt before running tools');
    } else {
      console.log('  ✗ agent will NOT prompt — remote approval is inoperative');
      for (const r of posture.reasons) console.log(`      · ${r}`);
      console.log(`    fix in ${posture.configPath}: [features] support_permission = true`);
      process.exitCode = 1;
    }
  } catch (err) {
    const message = (err as Error).message;
    console.log(`  ✗ ACP failed: ${message}`);
    const hint = authHint(message);
    if (hint) console.log(hint);
    process.exitCode = 1;
  } finally {
    client.close();
  }
  console.log('');
}

async function main(): Promise<void> {
  const { cmd, rest, flags } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'up':
      return cmdUp(flags);
    case 'pair':
      return cmdPair();
    case 'devices':
      return cmdDevices();
    case 'revoke':
      return cmdRevoke(rest, flags);
    case 'term': {
      // A terminal on the same daemon session the phone drives. Grok's own TUI
      // cannot share a backend, so this talks to grokrc instead of to grok.
      const { TerminalClient } = await import('./term/client.ts');
      return new TerminalClient({
        url: typeof flags.url === 'string' ? flags.url : undefined,
        sessionId: typeof flags.session === 'string' ? flags.session : undefined,
        newSession: flags.new === true,
        cwd: typeof flags.cwd === 'string' ? resolve(flags.cwd) : process.cwd(),
      }).run();
    }
    case 'config':
      return cmdConfig(rest);
    case 'doctor':
      return cmdDoctor();
    case 'relay': {
      const { RelayServer } = await import('./relay/server.ts');
      const relay = new RelayServer();
      const p = await relay.listen(Number(flags.port ?? 8080));
      console.log(`\n  grokrc relay listening on :${p}`);
      console.log('  point a daemon at it with: grokrc up --relay ws://<host>:' + p + '\n');
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`grokrc: ${(err as Error).message}`);
  process.exit(1);
});
