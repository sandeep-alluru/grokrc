#!/usr/bin/env node
/**
 * ACP protocol probe — captures Grok Build's real ACP wire behaviour.
 *
 * Spawns `grok agent stdio`, performs the handshake, and records every frame
 * to docs/captures/. We build against observed behaviour, not documentation.
 *
 *   node tools/acp-probe.mjs                 # handshake + session/new only (no model call)
 *   node tools/acp-probe.mjs --prompt "hi"   # also runs one prompt turn (costs tokens)
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'docs/captures');
const argv = process.argv.slice(2);
const promptIdx = argv.indexOf('--prompt');
const PROMPT = promptIdx !== -1 ? argv[promptIdx + 1] : null;

const frames = [];
const record = (dir, payload) => frames.push({ t: Date.now(), dir, payload });

const child = spawn('grok', ['agent', 'stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: ROOT,
});

let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  record('out', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => {
      if (pending.delete(id)) rej(new Error(`timeout waiting for ${method}`));
    }, 60_000);
  });
}

// The agent calls back into US for permission requests and fs access.
// Answer minimally so the handshake completes.
function respond(id, result) {
  const msg = { jsonrpc: '2.0', id, result };
  record('out', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
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
      record('in-unparsed', line);
      continue;
    }
    record('in', msg);

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      }
    } else if (msg.id !== undefined && msg.method) {
      // Agent -> client request. Auto-allow so we can observe the shape.
      console.log(`  <- agent request: ${msg.method}`);
      if (msg.method === 'session/request_permission') {
        const opts = msg.params?.options ?? [];
        const allow =
          opts.find((o) => /allow|approve|yes/i.test(o.optionId ?? o.name ?? '')) ?? opts[0];
        respond(msg.id, { outcome: { outcome: 'selected', optionId: allow?.optionId } });
      } else {
        respond(msg.id, {});
      }
    } else if (msg.method) {
      console.log(`  <- notify: ${msg.method} ${msg.params?.update?.sessionUpdate ?? ''}`);
    }
  }
});

let stderrBuf = '';
child.stderr.on('data', (c) => {
  stderrBuf += c.toString();
});

function dump(label) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = resolve(OUT_DIR, `acp-${label}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { grokVersion: process.env.GROK_VERSION ?? null, frames, stderr: stderrBuf },
      null,
      2
    )
  );
  console.log(`\ncaptured ${frames.length} frames -> ${file}`);
}

(async () => {
  try {
    console.log('-> initialize');
    const init = await send('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    console.log('   capabilities:', JSON.stringify(init).slice(0, 400));

    console.log('-> session/new');
    const session = await send('session/new', { cwd: ROOT, mcpServers: [] });
    console.log('   sessionId:', session?.sessionId);

    if (PROMPT) {
      console.log(`-> session/prompt: ${PROMPT}`);
      const turn = await send('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: PROMPT }],
      });
      console.log('   stopReason:', turn?.stopReason);
    }
    dump(PROMPT ? 'prompt-turn' : 'handshake');
    child.kill();
    process.exit(0);
  } catch (err) {
    console.error('PROBE FAILED:', err.message);
    if (stderrBuf) console.error('stderr:', stderrBuf.slice(0, 2000));
    dump('error');
    child.kill();
    process.exit(1);
  }
})();
