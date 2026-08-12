#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'grok-set-'));
const work = await mkdtemp(join(tmpdir(), 'grok-set-w-'));
await writeFile(
  join(home, 'config.toml'),
  `[features]
support_permission = true

[ui]
permission_mode = "default"
yolo = false
`
);
await copyFile(join(homedir(), '.grok', 'auth.json'), join(home, 'auth.json'));

const child = spawn('grok', ['agent', 'stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: work,
  env: { ...process.env, GROK_HOME: home, HOME: home },
});

let nextId = 1;
const pending = new Map();
let buf = '';

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.delete(id)) rej(new Error('timeout ' + method));
    }, 30_000);
  });
}

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
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      }
    } else if (msg.id !== undefined && msg.method) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
    } else if (msg.method === '_x.ai/settings/update') {
      const p = msg.params || {};
      console.log('settings keys:', Object.keys(p).join(', '));
      for (const [k, v] of Object.entries(p)) {
        const s = JSON.stringify(v);
        if (/perm|yolo|auto|approv|prompt|mode|feature|support/i.test(k + s)) {
          console.log(' ', k, ':', s.slice(0, 400));
        }
      }
      // full dump of permission_mode neighbours
      for (const k of [
        'permission_mode',
        'auto_permission_mode_enabled',
        'yolo',
        'support_permission',
        'features',
      ]) {
        if (k in p) console.log(' EXACT', k, JSON.stringify(p[k]));
      }
    }
  }
});

try {
  await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
  });
  try {
    await send('authenticate', { methodId: 'cached_token' });
  } catch {
    /* */
  }
  await send('session/new', { cwd: work, mcpServers: [] });
  await new Promise((r) => setTimeout(r, 2500));
} catch (e) {
  console.error(e);
} finally {
  child.kill();
}
