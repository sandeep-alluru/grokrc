#!/usr/bin/env node
/**
 * End-to-end drive: acts as the phone, headlessly.
 *
 * Closes the biggest verification gap in the project. Everything up to now
 * proved the handshake and the plumbing; this proves the thing the product
 * actually exists for — a real agent turn producing a real
 * `session/request_permission`, answered from a remote client, after which the
 * agent proceeds.
 *
 * Runs against dist/, so build first. Works in a scratch directory so the agent
 * never touches a real repo.
 *
 *   npm run build && node tools/e2e-drive.mjs
 */
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Isolate config so a test run never touches real pairing state.
const cfgDir = await mkdtemp(join(tmpdir(), 'grokrc-e2e-cfg-'));
process.env.GROKRC_HOME = cfgDir;

const { AuthStore } = await import('../dist/daemon/auth.js');
const { SessionManager } = await import('../dist/daemon/session-manager.js');
const { RemoteControlServer } = await import('../dist/daemon/server.js');
const { WebSocket } = await import('ws');

const workDir = await mkdtemp(join(tmpdir(), 'grokrc-e2e-work-'));
const capture = { events: [], approvals: [], transcript: [] };

// The user's global ~/.grok/config.toml may set `[ui] permission_mode = "auto"`,
// which auto-approves every tool and means the approval path never fires. A
// project-level .grok/config.toml overrides it (confirmed via `grok inspect`),
// so force a mode that actually asks — otherwise this test silently passes
// without ever exercising the feature it exists to prove.
// Permission prompting is OFF by default in Grok Build (`[features]
// support_permission = false`), and this machine's global config additionally
// sets `[ui] permission_mode = "auto"`. Neither key takes effect from a project
// .grok/config.toml — both are user-config-only. So build an isolated GROK_HOME
// (auth reused, config rewritten) rather than touching the user's real config.
const grokHome = await mkdtemp(join(tmpdir(), 'grokrc-e2e-grokhome-'));
const realGrokHome = join(process.env.HOME, '.grok');
await writeFile(
  join(grokHome, 'config.toml'),
  '[features]\nsupport_permission = true\n\n[ui]\npermission_mode = "default"\n'
);
// Reuse existing credentials so the run doesn't require a fresh login.
for (const f of ['auth.json', 'agent_id']) {
  try {
    await writeFile(join(grokHome, f), await readFile(join(realGrokHome, f)));
  } catch {
    /* optional */
  }
}
process.env.GROK_HOME = grokHome;

const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager();
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: join(ROOT, 'web'),
  sessions,
  auth,
  defaultCwd: workDir,
});
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;

function log(...a) {
  console.log(...a);
}

async function main() {
  /* 1. pair, exactly as a phone would */
  const { code } = auth.beginPairing();
  const pairRes = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'e2e-phone' }),
  });
  const { token } = await pairRes.json();
  log(`✓ paired (token ${token.slice(0, 12)}…)`);

  /* 2. connect as the phone */
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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
      log('✓ authenticated');
      ws.send(JSON.stringify({ t: 'create', cwd: workDir }));
      return;
    }

    if (msg.t === 'created') {
      sessionId = msg.session.id;
      log(`✓ session created: ${sessionId}`);
      // A write forces a permission request under the default policy.
      const prompt = 'Create a file named hello.txt containing exactly: grok';
      log(`→ prompt: ${prompt}`);
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
          log(`  [${ev.role}] ${ev.text.slice(0, 120).replace(/\n/g, ' ')}`);
        }
        break;

      case 'tool':
        log(`  [tool] ${ev.title ?? ev.name} — ${ev.status}`);
        break;

      case 'approval': {
        sawApproval = true;
        capture.approvals.push(ev);
        log(`\n  ★ REAL PERMISSION REQUEST`);
        log(`    title:   ${ev.title}`);
        log(`    tool:    ${ev.toolName ?? '(none)'}`);
        log(`    options: ${JSON.stringify(ev.options)}`);
        log(`    input:   ${JSON.stringify(ev.input).slice(0, 200)}\n`);

        const allow = ev.options.find((o) => o.intent === 'allow') ?? ev.options[0];
        if (!allow) {
          log('    !! no option classified as allow — this is the bug to fix');
          return;
        }
        log(`    → approving with "${allow.label}" (${allow.id})`);
        approvalAnswered = true;
        ws.send(
          JSON.stringify({ t: 'approve', sessionId, requestId: ev.requestId, optionId: allow.id })
        );
        break;
      }

      case 'status':
        log(`  [status] ${ev.state}`);
        if (ev.state === 'done' || ev.state === 'error') done = true;
        break;

      case 'error':
        log(`  [error] ${ev.message}`);
        break;
    }
  });

  /* 3. wait for the turn to finish */
  const deadline = Date.now() + 180_000;
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }

  /* 4. did the agent actually do the work? */
  let fileContents = null;
  try {
    fileContents = (await readFile(join(workDir, 'hello.txt'), 'utf8')).trim();
  } catch {
    /* not created */
  }

  log('\n─── RESULT ───────────────────────────────');
  log(`  turn completed:      ${done}`);
  log(`  permission request:  ${sawApproval}`);
  log(`  approved remotely:   ${approvalAnswered}`);
  log(
    `  hello.txt:           ${fileContents === null ? 'NOT CREATED' : JSON.stringify(fileContents)}`
  );
  log(`  events captured:     ${capture.events.length}`);
  log(`  event kinds:         ${[...new Set(capture.events.map((e) => e.k))].join(', ')}`);

  await mkdir(join(ROOT, 'docs/captures'), { recursive: true });
  await writeFile(join(ROOT, 'docs/captures/e2e-drive.json'), JSON.stringify(capture, null, 2));
  log(`\n  -> docs/captures/e2e-drive.json`);

  ws.close();
  sessions.closeAll();
  await server.close();
  await rm(workDir, { recursive: true, force: true });
  await rm(cfgDir, { recursive: true, force: true });
  await rm(grokHome, { recursive: true, force: true });

  // Non-zero if the thing the product exists for did not happen.
  process.exit(sawApproval && approvalAnswered && fileContents !== null ? 0 : 1);
}

main().catch(async (err) => {
  console.error('E2E FAILED:', err);
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  await rm(cfgDir, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
