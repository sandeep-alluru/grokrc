/**
 * Observer tests run against a synthetic log with the exact on-disk shape, plus
 * — when this machine has one — a real Grok session log, so format drift in
 * `updates.jsonl` fails here rather than silently in production.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionObserver } from '../src/daemon/observer.ts';
import type { RcEvent } from '../src/daemon/events.ts';

const line = (kind: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    timestamp: 1784608973,
    method: 'session/update',
    params: { sessionId: 's1', update: { sessionUpdate: kind, ...extra } },
  }) + '\n';

async function collect(dir: string, ms = 400): Promise<RcEvent[]> {
  const events: RcEvent[] = [];
  const obs = new SessionObserver({ sessionDir: dir, pollMs: 30 });
  obs.on('event', (e) => events.push(e));
  await obs.start();
  await new Promise((r) => setTimeout(r, ms));
  obs.stop();
  return events;
}

test('replays a log that already exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  await writeFile(
    join(dir, 'updates.jsonl'),
    line('agent_message_chunk', { content: { type: 'text', text: 'hello' } }) +
      line('tool_call', { toolCallId: 't1', title: 'Read file', status: 'completed' })
  );
  const events = await collect(dir, 150);
  await rm(dir, { recursive: true, force: true });

  assert.ok(events.some((e) => e.k === 'text' && e.text === 'hello'));
  assert.ok(events.some((e) => e.k === 'tool' && e.status === 'ok'));
});

test('follows appends after start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  const file = join(dir, 'updates.jsonl');
  await writeFile(file, line('agent_message_chunk', { content: { type: 'text', text: 'a' } }));

  const events: RcEvent[] = [];
  const obs = new SessionObserver({ sessionDir: dir, pollMs: 20 });
  obs.on('event', (e) => events.push(e));
  await obs.start();

  await appendFile(file, line('agent_message_chunk', { content: { type: 'text', text: 'b' } }));
  await new Promise((r) => setTimeout(r, 200));
  obs.stop();
  await rm(dir, { recursive: true, force: true });

  const texts = events.filter((e) => e.k === 'text').map((e) => (e as { text: string }).text);
  assert.deepEqual(texts, ['a', 'b']);
});

test('a line split across two writes is not emitted until complete', async () => {
  // Grok appends with its own buffering; we must never parse half a frame.
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  const file = join(dir, 'updates.jsonl');
  await writeFile(file, '');

  const events: RcEvent[] = [];
  const obs = new SessionObserver({ sessionDir: dir, pollMs: 20 });
  obs.on('event', (e) => events.push(e));
  await obs.start();

  const full = line('agent_message_chunk', { content: { type: 'text', text: 'split' } });
  await appendFile(file, full.slice(0, 40));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(events.length, 0, 'partial frame must not be emitted');

  await appendFile(file, full.slice(40));
  await new Promise((r) => setTimeout(r, 120));
  obs.stop();
  await rm(dir, { recursive: true, force: true });

  assert.ok(events.some((e) => e.k === 'text' && e.text === 'split'));
});

test('a missing log is not an error — the dir can exist first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  const errors: Error[] = [];
  const obs = new SessionObserver({ sessionDir: dir, pollMs: 20 });
  obs.on('error', (e) => errors.push(e));
  await obs.start();
  await new Promise((r) => setTimeout(r, 100));
  obs.stop();
  await rm(dir, { recursive: true, force: true });
  assert.equal(errors.length, 0);
});

test('the vendor-prefixed _x.ai/session/update method is accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  await writeFile(
    join(dir, 'updates.jsonl'),
    JSON.stringify({
      timestamp: 1,
      method: '_x.ai/session/update',
      params: { sessionId: 's', update: { sessionUpdate: 'turn_completed' } },
    }) + '\n'
  );
  const events = await collect(dir, 150);
  await rm(dir, { recursive: true, force: true });
  assert.ok(events.some((e) => e.k === 'status' && e.state === 'done'));
});

/* ─── real data ───────────────────────────────────────────────────────────── */

test('parses a real Grok session log on this machine', async (t) => {
  // Deliberately the REAL home, not GROK_HOME. The point of this test is to
  // parse logs a real grok actually wrote; the suite runs under a scratch
  // GROK_HOME (tools/isolated-test.mjs) which by design contains none. Read-only,
  // so it cannot pollute what it reads.
  const root = join(homedir(), '.grok', 'sessions');
  if (!existsSync(root)) return t.skip('no ~/.grok/sessions on this machine');

  let found: string | null = null;
  for (const cwdDir of await readdir(root)) {
    const full = join(root, cwdDir);
    let ids: string[];
    try {
      ids = await readdir(full);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (existsSync(join(full, id, 'updates.jsonl'))) {
        found = join(full, id);
        break;
      }
    }
    if (found) break;
  }
  if (!found) return t.skip('no session log found');

  const events = await collect(found, 500);
  assert.ok(events.length > 0, 'real log produced no events');

  // The whole value of observed mode is that the same normalizer handles disk
  // and wire. If a real log yields only `raw`, the format has drifted.
  const known = events.filter((e) => e.k !== 'raw');
  assert.ok(
    known.length > 0,
    `real log produced only unrecognized events — updates.jsonl format may have changed`
  );
});
