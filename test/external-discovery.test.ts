/**
 * B7 — a Grok TUI session must show up on the phone without reconnecting.
 *
 * Pre-fix: list was only pushed on connect / daemon-owned changes. Starting
 * `grok` in a terminal updated active_sessions.json and never triggered a
 * broadcast, so a phone already on the list stayed empty of that session.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { watch } from './helpers/ws.ts';

const grokHome = await mkdtemp(join(tmpdir(), 'grokrc-extdisc-grok-'));
const rcHome = await mkdtemp(join(tmpdir(), 'grokrc-extdisc-rc-'));
process.env.GROK_HOME = grokHome;
process.env.GROKRC_HOME = rcHome;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { WebSocket } = await import('ws');

const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager();
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
  defaultCwd: grokHome,
  historyLimit: 10,
});
const { port } = await server.listen();

after(async () => {
  await server.close();
  await rm(grokHome, { recursive: true, force: true });
  await rm(rcHome, { recursive: true, force: true });
});

async function pairPhone() {
  const { code } = auth.beginPairing();
  const res = await fetch(`http://127.0.0.1:${port}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'ext-disc' }),
  });
  const { token } = (await res.json()) as { token: string };
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r, j) => {
    sock.once('open', () => r());
    sock.once('error', j);
  });
  const frames = watch<any>(sock);
  sock.send(JSON.stringify({ t: 'hello', token }));
  await frames.forType('ready');
  sock.send(JSON.stringify({ t: 'sessions' }));
  await frames.forType('sessions');
  return { sock, frames };
}

/** Plant a Grok-shaped session on disk + registry (what the TUI does). */
async function plantExternalSession(id: string, cwd: string, pid: number) {
  // Registry first so a discovery poll cannot see the summary as "past" before
  // the live pid is recorded.
  await writeFile(
    join(grokHome, 'active_sessions.json'),
    JSON.stringify([{ session_id: id, pid, cwd, opened_at: new Date().toISOString() }])
  );
  const dir = join(grokHome, 'sessions', encodeURIComponent(cwd), id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'summary.json'),
    JSON.stringify({
      info: { id, cwd },
      session_summary: 'External TUI session',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_model_id: 'grok-4.5',
    })
  );
}

test('discoverOnDisk marks a live registry pid as externallyActive', async () => {
  const id = '019fabcd-0000-7000-8000-00000000ext';
  // This process is alive — use our own pid so liveness probe succeeds.
  await plantExternalSession(id, grokHome, process.pid);
  const list = await sessions.discoverOnDisk(10);
  const hit = list.find((s) => s.id === id);
  assert.ok(hit, 'planted session must appear');
  assert.equal(hit!.externallyActive, true, 'live pid must mark live in terminal');
  assert.equal(hit!.title, 'External TUI session');
});

test('daemon pushes an updated sessions list when an external session appears', async () => {
  const { sock, frames } = await pairPhone();
  const id = '019fabcd-0000-7000-8000-00000000new';

  // Plant AFTER the phone is already connected — the pre-fix gap.
  await plantExternalSession(id, grokHome, process.pid);

  const updated = await frames.waitFor(
    (m) =>
      m.t === 'sessions' &&
      Array.isArray(m.sessions) &&
      m.sessions.some(
        (s: { id: string; externallyActive?: boolean }) => s.id === id && s.externallyActive
      ),
    8_000
  );
  const row = updated.sessions.find((s: { id: string }) => s.id === id);
  assert.ok(row, 'phone must receive the new external session without reconnecting');
  assert.equal(row.externallyActive, true, 'must show live in terminal');
  sock.close();
});
