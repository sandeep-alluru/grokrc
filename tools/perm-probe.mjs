#!/usr/bin/env node
/**
 * Live probe: does Grok 1.0 emit session/request_permission for a write turn?
 *
 * Isolated GROK_HOME with support_permission=true, writeTextFile capability OFF
 * (advertising write is the known silent approval bypass).
 *
 *   node tools/perm-probe.mjs
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'grok-perm-'));
const work = await mkdtemp(join(tmpdir(), 'grok-perm-work-'));
await writeFile(
  join(home, 'config.toml'),
  `[features]
support_permission = true

[ui]
permission_mode = "default"
yolo = false
`
);
try {
  await copyFile(join(homedir(), '.grok', 'auth.json'), join(home, 'auth.json'));
} catch (e) {
  console.error('need ~/.grok/auth.json:', e.message);
  process.exit(2);
}

const child = spawn('grok', ['agent', 'stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: work,
  env: { ...process.env, GROK_HOME: home, HOME: home },
});

let nextId = 1;
const pending = new Map();
const agentRequests = [];
const updates = [];
const settingsHits = [];

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

let buf = '';
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
      agentRequests.push({ method: msg.method, params: msg.params });
      console.log('AGENT REQ:', msg.method);
      if (msg.method === 'session/request_permission') {
        const opts = msg.params?.options ?? [];
        console.log('  options:', JSON.stringify(opts).slice(0, 400));
        const allow = opts.find((o) => /allow/i.test(o.optionId || o.name || '')) ?? opts[0];
        respond(msg.id, {
          outcome: { outcome: 'selected', optionId: allow?.optionId },
        });
      } else if (msg.method === 'fs/read_text_file') {
        respond(msg.id, { content: '' });
      } else if (msg.method === 'fs/write_text_file') {
        console.log('  !! fs/write_text_file despite write off');
        respond(msg.id, null);
      } else {
        console.log('  params:', JSON.stringify(msg.params).slice(0, 300));
        respond(msg.id, {});
      }
    } else if (msg.method === 'session/update') {
      const su = msg.params?.update?.sessionUpdate;
      updates.push(su);
      if (
        su === 'pending_interaction' ||
        su === 'interaction_resolved' ||
        su === 'tool_call' ||
        su === 'tool_call_update'
      ) {
        console.log('UPDATE', su, JSON.stringify(msg.params?.update).slice(0, 500));
      }
    } else if (msg.method) {
      const s = JSON.stringify(msg.params ?? {});
      if (/permission|yolo|auto_perm|interaction|always.?approve/i.test(s)) {
        settingsHits.push({ method: msg.method, s: s.slice(0, 600) });
        console.log('VENDOR', msg.method, s.slice(0, 500));
      }
    }
  }
});

let stderr = '';
child.stderr.on('data', (c) => {
  stderr += c.toString();
});

try {
  console.log('GROK_HOME', home);
  console.log('work', work);
  const init = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
  });
  console.log('init _meta slice:', JSON.stringify(init._meta ?? {}).slice(0, 400));
  try {
    await send('authenticate', { methodId: 'cached_token' });
    console.log('auth ok');
  } catch (e) {
    console.log('auth:', e.message.slice(0, 120));
  }
  const session = await send('session/new', { cwd: work, mcpServers: [] });
  console.log('session', session.sessionId);
  console.log('prompting write…');
  const turn = await send('session/prompt', {
    sessionId: session.sessionId,
    prompt: [
      {
        type: 'text',
        text: 'Create a file named hello.txt containing exactly: grok. You must use a file-write tool.',
      },
    ],
  });
  console.log('stopReason', turn?.stopReason);
  console.log(
    'agent→client methods:',
    agentRequests.map((r) => r.method)
  );
  console.log('unique sessionUpdate kinds:', [...new Set(updates)]);
  console.log('settingsHits', settingsHits.length);
  try {
    console.log('file:', JSON.stringify(await readFile(join(work, 'hello.txt'), 'utf8')));
  } catch {
    console.log('file: missing');
  }
  const sawPerm = agentRequests.some((r) => r.method === 'session/request_permission');
  console.log(sawPerm ? 'RESULT: permission RPC seen' : 'RESULT: NO session/request_permission');
} catch (e) {
  console.error('FAIL', e.message);
  if (stderr) console.error('stderr', stderr.slice(0, 2000));
  process.exitCode = 1;
} finally {
  child.kill();
}
