#!/usr/bin/env node
/**
 * Try forcing Grok 1.0 permission prompts via CLI flag:
 *   grok --permission-mode default agent stdio
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'grok-permf-'));
const work = await mkdtemp(join(tmpdir(), 'grok-permf-w-'));
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

const argv = ['--permission-mode', 'default', 'agent', 'stdio'];
console.log('spawn: grok', argv.join(' '));
const child = spawn('grok', argv, {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: work,
  env: { ...process.env, GROK_HOME: home, HOME: home },
});

let nextId = 1;
const pending = new Map();
const agentReqs = [];
let buf = '';

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.delete(id)) rej(new Error('timeout ' + method));
    }, 180_000);
  });
}

function respond(id, result) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
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
      agentReqs.push(msg.method);
      console.log('AGENT REQ:', msg.method);
      if (msg.method === 'session/request_permission') {
        console.log('  ★ PERMISSION', JSON.stringify(msg.params).slice(0, 500));
        const opts = msg.params?.options ?? [];
        const allow = opts.find((o) => /allow/i.test(o.optionId || o.name || '')) ?? opts[0];
        respond(msg.id, {
          outcome: { outcome: 'selected', optionId: allow?.optionId },
        });
      } else if (msg.method === 'fs/read_text_file') {
        respond(msg.id, { content: '' });
      } else {
        respond(msg.id, {});
      }
    } else if (msg.method === '_x.ai/settings/update') {
      console.log(
        'permission_mode=',
        msg.params?.permission_mode,
        'auto=',
        msg.params?.auto_permission_mode_enabled
      );
    } else if (msg.method === '_x.ai/session_notification') {
      const su = msg.params?.update?.sessionUpdate;
      if (su === 'pending_interaction' || su === 'interaction_resolved') {
        console.log('VENDOR', su, JSON.stringify(msg.params?.update).slice(0, 300));
      }
    } else if (msg.method === '_x.ai/sessions/changed') {
      const y = msg.params?.upserted?.[0]?.yolo;
      if (y !== undefined) console.log('session yolo=', y);
    }
  }
});

let stderr = '';
child.stderr.on('data', (c) => {
  stderr += c.toString();
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
  const session = await send('session/new', { cwd: work, mcpServers: [] });
  console.log('session', session.sessionId);
  const turn = await send('session/prompt', {
    sessionId: session.sessionId,
    prompt: [
      {
        type: 'text',
        text: 'Create hello.txt containing exactly: grok. Use a write tool.',
      },
    ],
  });
  console.log('stopReason', turn?.stopReason);
  console.log('agent→client:', agentReqs);
  try {
    console.log('file:', JSON.stringify(await readFile(join(work, 'hello.txt'), 'utf8')));
  } catch {
    console.log('file: missing');
  }
  console.log(
    agentReqs.includes('session/request_permission')
      ? 'RESULT: permission RPC SEEN'
      : 'RESULT: still NO session/request_permission'
  );
} catch (e) {
  console.error('FAIL', e.message);
  if (stderr) console.error(stderr.slice(0, 1500));
  process.exitCode = 1;
} finally {
  child.kill();
}
