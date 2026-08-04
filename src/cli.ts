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
      --relay <URL>    Dial OUT to a relay — no inbound port, works on cellular
      --room <ID>      Relay room id (generated if omitted)
      --relay-key <K>  Relay room key (generated if omitted)

  grokrc relay       Run a self-hostable relay server
      --port <N>       Port (default 8080)

  grokrc pair        Print a pairing code for a new device
  grokrc devices     List paired devices
  grokrc revoke <id> Revoke a device  (--all to revoke everything)
  grokrc doctor      Check that grok is installed and ACP responds
`;

async function cmdUp(flags: Flags): Promise<void> {
  const auth = new AuthStore();
  await auth.load();

  const push = new PushService();
  if (flags['no-push'] !== true) await push.load();

  const sessions = new SessionManager({
    model: typeof flags.model === 'string' ? flags.model : undefined,
    useLeader: flags.leader === true,
  });

  const host = flags.lan === true ? '0.0.0.0' : (flags.host as string) ?? '127.0.0.1';
  const port = Number(flags.port ?? 4319);

  const server = new RemoteControlServer({
    host,
    port,
    webRoot: WEB_ROOT,
    sessions,
    auth,
    push: flags['no-push'] === true ? undefined : push,
    defaultCwd: typeof flags.cwd === 'string' ? resolve(flags.cwd) : process.cwd(),
  });

  const bound = await server.listen();
  const shown = host === '0.0.0.0' ? lanAddress() ?? '0.0.0.0' : host;

  if (typeof flags.relay === 'string') {
    const room = typeof flags.room === 'string' ? flags.room : randomBytes(6).toString('hex');
    const key = typeof flags['relay-key'] === 'string' ? flags['relay-key'] : randomBytes(16).toString('hex');
    server.connectRelay({ url: flags.relay, room, key });
    console.log(`\n  relay: ${flags.relay}`);
    console.log(`  phone URL: ${flags.relay.replace(/^ws/, 'http')}/client?room=${room}&key=${key}`);
    console.log('  (no inbound port needed — this machine dials out)');
  }

  console.log(`\n  grokrc listening on http://${shown}:${bound.port}`);
  if (host === '0.0.0.0') {
    console.log('  ⚠ bound to all interfaces — keep this on a trusted network or a Tailnet.');
  } else {
    console.log('  loopback only. Use --lan to reach it from your phone, or tunnel it.');
  }

  if (auth.devices.length === 0) {
    const { code } = auth.beginPairing();
    console.log(`\n  No paired devices. Open the URL above on your phone and enter:\n`);
    console.log(`      ${code}\n`);
    console.log('  (valid 5 minutes, single use — run `grokrc pair` for another)');
  } else {
    console.log(`  ${auth.devices.length} paired device(s). \`grokrc pair\` to add another.`);
  }
  console.log('');

  const shutdown = async () => {
    console.log('\nshutting down…');
    sessions.closeAll();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function cmdPair(): Promise<void> {
  // Pairing codes live in the running daemon's memory, so this only makes sense
  // as a hint until the control socket lands. Say so rather than printing a code
  // that will not work.
  console.log(
    '\n  Pairing codes are issued by the running daemon.\n' +
      '  Start it with `grokrc up` — it prints a code when no device is paired.\n' +
      '  (A `grokrc pair` that talks to a live daemon needs the control socket: see docs/01-architecture.md §7.)\n'
  );
}

async function cmdDevices(): Promise<void> {
  const auth = new AuthStore();
  await auth.load();
  if (auth.devices.length === 0) return console.log('\n  no paired devices\n');
  console.log('');
  for (const d of auth.devices) {
    console.log(
      `  ${d.id}  ${d.name.padEnd(20)}  paired ${new Date(d.pairedAt).toLocaleString()}  last seen ${new Date(d.lastSeen).toLocaleString()}`
    );
  }
  console.log('');
}

async function cmdRevoke(rest: string[], flags: Flags): Promise<void> {
  const auth = new AuthStore();
  await auth.load();
  if (flags.all === true) {
    await auth.revokeAll();
    return console.log('  all devices revoked');
  }
  const id = rest[0];
  if (!id) return console.log('  usage: grokrc revoke <deviceId> | --all');
  console.log((await auth.revoke(id)) ? `  revoked ${id}` : `  no such device: ${id}`);
}

async function cmdDoctor(): Promise<void> {
  console.log('');
  try {
    const { stdout } = await execFileAsync('grok', ['--version']);
    console.log(`  ✓ grok found: ${stdout.trim()}`);
  } catch {
    console.log('  ✗ grok not found on PATH — install: curl -fsSL https://x.ai/cli/install.sh | bash');
    process.exitCode = 1;
    return;
  }

  const { StdioTransport } = await import('./acp/transport.ts');
  const { AcpClient } = await import('./acp/client.ts');
  const client = new AcpClient({ transport: new StdioTransport({ cwd: process.cwd() }) });
  try {
    const init = await client.initialize();
    console.log(`  ✓ ACP handshake ok (protocolVersion ${init.protocolVersion})`);
    console.log(`    loadSession: ${init.agentCapabilities?.loadSession ?? false}`);
    console.log(`    auth methods: ${(init.authMethods ?? []).map((m) => m.id).join(', ') || 'none'}`);
    const s = await client.newSession(process.cwd());
    console.log(`  ✓ session/new ok (${s.sessionId})`);
  } catch (err) {
    console.log(`  ✗ ACP failed: ${(err as Error).message}`);
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
