#!/usr/bin/env node
/**
 * B4 — try every Grok 1.0 permission-mode CLI value and record whether
 * session/request_permission ever appears for a write turn.
 *
 * Isolated GROK_HOME each mode. Writes docs/captures/perm-modes.json.
 *
 *   node tools/perm-probe-modes.mjs
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'];

async function runMode(mode) {
  const home = await mkdtemp(join(tmpdir(), `grok-pm-${mode}-`));
  const work = await mkdtemp(join(tmpdir(), `grok-pmw-${mode}-`));
  await writeFile(
    join(home, 'config.toml'),
    `[features]
support_permission = true

[ui]
permission_mode = "${mode}"
yolo = false
`
  );
  await copyFile(join(homedir(), '.grok', 'auth.json'), join(home, 'auth.json'));

  const child = spawn('grok', ['--permission-mode', mode, 'agent', 'stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: work,
    env: { ...process.env, GROK_HOME: home, HOME: home },
  });

  let nextId = 1;
  const pending = new Map();
  const agentReqs = [];
  const vendor = [];
  let settingsPermission = null;
  let buf = '';
  let stderr = '';

  function send(method, params) {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      setTimeout(() => {
        if (pending.delete(id)) rej(new Error('timeout ' + method));
      }, 120_000);
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
        if (msg.method === 'session/request_permission') {
          const opts = msg.params?.options ?? [];
          const allow =
            opts.find((o) => /allow/i.test(o.optionId || o.name || '')) ?? opts[0];
          respond(msg.id, {
            outcome: { outcome: 'selected', optionId: allow?.optionId },
          });
        } else if (msg.method === 'fs/read_text_file') {
          respond(msg.id, { content: '' });
        } else {
          respond(msg.id, {});
        }
      } else if (msg.method === '_x.ai/settings/update') {
        settingsPermission = {
          permission_mode: msg.params?.permission_mode ?? null,
          auto_permission_mode_enabled: msg.params?.auto_permission_mode_enabled ?? null,
        };
      } else if (msg.method === '_x.ai/session_notification') {
        const su = msg.params?.update?.sessionUpdate;
        if (su === 'pending_interaction' || su === 'interaction_resolved') {
          vendor.push({ su, kind: msg.params?.update?.kind });
        }
      }
    }
  });
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });

  const row = {
    mode,
    sawPermissionRpc: false,
    agentRequests: [],
    vendor,
    settingsPermission,
    stopReason: null,
    fileWritten: false,
    error: null,
  };

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
    const turn = await send('session/prompt', {
      sessionId: session.sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Create hello.txt with exact contents: grok. Use a write tool.',
        },
      ],
    });
    row.stopReason = turn?.stopReason ?? null;
    row.agentRequests = agentReqs;
    row.sawPermissionRpc = agentReqs.includes('session/request_permission');
    row.settingsPermission = settingsPermission;
    row.vendor = vendor;
    try {
      const { readFile } = await import('node:fs/promises');
      await readFile(join(work, 'hello.txt'), 'utf8');
      row.fileWritten = true;
    } catch {
      row.fileWritten = false;
    }
  } catch (e) {
    row.error = e.message;
    if (stderr) row.stderr = stderr.slice(0, 500);
  } finally {
    child.kill();
  }
  return row;
}

const results = [];
console.log('B4 permission-mode matrix (Grok 1.0)…');
for (const mode of MODES) {
  process.stdout.write(`  ${mode}… `);
  const row = await runMode(mode);
  results.push(row);
  console.log(
    row.error
      ? `ERR ${row.error.slice(0, 80)}`
      : `permRpc=${row.sawPermissionRpc} file=${row.fileWritten} settings=${JSON.stringify(row.settingsPermission)} vendor=${row.vendor.map((v) => v.su).join(',') || 'none'}`
  );
}

await mkdir(join(ROOT, 'docs/captures'), { recursive: true });
const out = join(ROOT, 'docs/captures/perm-modes.json');
await writeFile(
  out,
  JSON.stringify(
    {
      when: new Date().toISOString(),
      grok: '1.0.0',
      results,
      anyPermissionRpc: results.some((r) => r.sawPermissionRpc),
    },
    null,
    2
  )
);
console.log('\nwrote', out);
console.log(
  results.some((r) => r.sawPermissionRpc)
    ? 'RESULT: at least one mode emitted session/request_permission'
    : 'RESULT: NO mode emitted session/request_permission'
);
process.exit(results.some((r) => r.sawPermissionRpc) ? 0 : 2);
