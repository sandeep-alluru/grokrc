#!/usr/bin/env node
/**
 * Leader-mode probe.
 *
 * `grok agent leader` advertises "multiple clients share one backend" — the
 * capability grokrc's `--leader` flag depends on for laptop↔phone handoff, and
 * the one thing in the README that had never been exercised.
 *
 * Question this answers: if client A creates a session against a shared leader,
 * can client B — a separate process — see and load that same session? If yes,
 * handoff is real. If no, `--leader` means something weaker and the docs are wrong.
 *
 * Deliberately avoids sending a prompt, so it costs nothing.
 *
 *   node tools/leader-probe.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workDir = await mkdtemp(join(tmpdir(), 'grokrc-leader-'));
const sock = join(workDir, 'leader.sock');

const log = (...a) => console.log(...a);

/** Minimal ACP client over a spawned grok process. */
function client(name, extraArgs) {
  const child = spawn('grok', ['agent', '--leader', '--leader-socket', sock, 'stdio', ...extraArgs], {
    cwd: workDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  const notes = [];

  child.stdout.on('data', (c) => {
    buf += c.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
        }
      } else if (msg.id !== undefined && msg.method) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
      } else {
        notes.push(msg.method);
      }
    }
  });
  child.stderr.on('data', (c) => {
    const s = c.toString().trim();
    if (s) log(`    [${name} stderr] ${s.split('\n')[0].slice(0, 140)}`);
  });

  return {
    child,
    notes,
    req(method, params, timeout = 45000) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        setTimeout(() => {
          if (pending.delete(id)) rej(new Error(`timeout: ${method}`));
        }, timeout);
      });
    },
    kill: () => child.kill(),
  };
}

async function waitForSocket(path, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

let leader;
try {
  log(`workdir: ${workDir}`);
  log(`socket:  ${sock}\n`);

  log('1. starting `grok agent leader --no-exit-on-disconnect`');
  leader = spawn(
    'grok',
    ['agent', 'leader', '--no-exit-on-disconnect', '--leader-socket', sock, '--no-auto-update'],
    { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  leader.stderr.on('data', (c) => {
    const s = c.toString().trim();
    if (s) log(`    [leader] ${s.split('\n')[0].slice(0, 140)}`);
  });

  const up = await waitForSocket(sock);
  log(`   socket present: ${up}`);
  if (!up) throw new Error('leader socket never appeared');

  log('\n2. `grok leader list`');
  await new Promise((res) => {
    const p = spawn('grok', ['leader', 'list', '--leader-socket', sock], { stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('close', () => {
      log('   ' + out.trim().split('\n').join('\n   '));
      res();
    });
  });

  log('\n3. client A connects with --leader');
  const a = client('A', []);
  const initA = await a.req('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  log(`   A initialize ok (protocol ${initA.protocolVersion})`);
  const sessionA = await a.req('session/new', { cwd: workDir, mcpServers: [] });
  log(`   A session/new: ${sessionA.sessionId}`);

  log('\n4. client B connects with --leader (separate process)');
  const b = client('B', []);
  const initB = await b.req('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  log(`   B initialize ok (protocol ${initB.protocolVersion})`);

  log("\n5. can B see A's session?");
  let listed = null;
  try {
    const list = await b.req('session/list', {});
    const ids = JSON.stringify(list).match(/[0-9a-f-]{36}/g) ?? [];
    listed = ids.includes(sessionA.sessionId);
    log(`   session/list contains A's session: ${listed}`);
  } catch (err) {
    log(`   session/list failed: ${err.message}`);
  }

  log("\n6. can B LOAD A's session? (the real handoff test)");
  let loaded = false;
  try {
    await b.req('session/load', { sessionId: sessionA.sessionId, cwd: workDir, mcpServers: [] });
    loaded = true;
    log('   ✓ B loaded the session created by A — shared backend confirmed');
  } catch (err) {
    log(`   ✗ session/load failed: ${err.message.slice(0, 200)}`);
  }

  log('\n─── VERDICT ─────────────────────────');
  log(`  leader socket:        ${up}`);
  log(`  two clients attached: true`);
  log(`  B sees A's session:   ${listed}`);
  log(`  B loads A's session:  ${loaded}`);

  a.kill();
  b.kill();
} catch (err) {
  console.error('PROBE FAILED:', err.message);
  process.exitCode = 1;
} finally {
  leader?.kill();
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
