#!/usr/bin/env node
/**
 * End-to-end drive: acts as the phone, headlessly, against a REAL agent.
 *
 * Proves the thing the product exists for — a genuine
 * `session/request_permission` answered from a remote client, after which the
 * agent proceeds.
 *
 * Uses an isolated GROK_HOME with prompting enabled, because Grok does not ask
 * by default (`[features] support_permission = false`) and this machine's config
 * additionally sets `[ui] permission_mode = "auto"`. Neither key takes effect
 * from a project `.grok/config.toml` — so the alternative would be editing the
 * owner's real config, which this must never do.
 *
 *   npm run build && node tools/e2e-drive.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bootDaemon, isolatedGrokHome, pairDevice, reporter, cleanup, ROOT } from './harness.mjs';

const { note, finish } = reporter();
const capture = { events: [], approvals: [], transcript: [] };

await isolatedGrokHome({ prompting: true });
const daemon = await bootDaemon(); // REAL grok, prompting on
const token = await pairDevice(daemon.base, daemon.auth, 'e2e-phone');
console.log(`✓ paired (token ${token.slice(0, 12)}…)`);

const { WebSocket } = await import('ws');
const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
await new Promise((res, rej) => {
  ws.once('open', res);
  ws.once('error', rej);
});
ws.send(JSON.stringify({ t: 'hello', token }));

let sessionId = null;
let done = false;
let sawApproval = false;
let approvalAnswered = false;

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.t === 'ready') {
    console.log('✓ authenticated');
    ws.send(JSON.stringify({ t: 'create', cwd: daemon.workDir }));
    return;
  }
  if (msg.t === 'created') {
    sessionId = msg.session.id;
    console.log(`✓ session created: ${sessionId}`);
    const prompt = 'Create a file named hello.txt containing exactly: grok';
    console.log(`→ prompt: ${prompt}`);
    ws.send(JSON.stringify({ t: 'prompt', sessionId, text: prompt }));
    return;
  }
  if (msg.t !== 'event') return;

  const ev = msg.event;
  capture.events.push(ev);

  switch (ev.k) {
    case 'text':
      if (ev.final) {
        capture.transcript.push({ role: ev.role, text: ev.text });
        console.log(`  [${ev.role}] ${ev.text.slice(0, 120).replace(/\n/g, ' ')}`);
      }
      break;

    case 'tool':
      console.log(`  [tool] ${ev.title ?? ev.name} — ${ev.status}`);
      break;

    case 'approval': {
      sawApproval = true;
      capture.approvals.push(ev);
      console.log(`\n  ★ REAL PERMISSION REQUEST`);
      console.log(`    title:   ${ev.title}`);
      console.log(`    options: ${JSON.stringify(ev.options)}`);
      const allow = ev.options.find((o) => o.intent === 'allow') ?? ev.options[0];
      if (!allow) {
        console.log('    !! no option classified as allow — that is the bug');
        return;
      }
      console.log(`    → approving with "${allow.label}" (${allow.id})\n`);
      approvalAnswered = true;
      ws.send(
        JSON.stringify({ t: 'approve', sessionId, requestId: ev.requestId, optionId: allow.id })
      );
      break;
    }

    case 'status':
      console.log(`  [status] ${ev.state}`);
      if (ev.state === 'done' || ev.state === 'error') done = true;
      break;

    case 'error':
      console.log(`  [error] ${ev.message}`);
      break;
  }
});

const deadline = Date.now() + 180_000;
while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));

let fileContents = null;
try {
  fileContents = (await readFile(join(daemon.workDir, 'hello.txt'), 'utf8')).trim();
} catch {
  /* not created */
}

console.log('');
note(done, 'turn completed');
note(sawApproval, 'a real permission request arrived');
note(approvalAnswered, 'it was approved from the remote client');
note(fileContents !== null, `hello.txt written (${JSON.stringify(fileContents)})`);
console.log(
  `  events: ${capture.events.length} · kinds: ${[...new Set(capture.events.map((e) => e.k))].join(', ')}`
);

await mkdir(join(ROOT, 'docs/captures'), { recursive: true });
await writeFile(join(ROOT, 'docs/captures/e2e-drive.json'), JSON.stringify(capture, null, 2));
console.log(`\n  -> docs/captures/e2e-drive.json`);

const code = finish();
ws.close();
await daemon.close();
await cleanup();
process.exit(code);
