/**
 * Observer: multi-byte UTF-8 across a read boundary.
 *
 * `#read()` takes BYTE offsets but decodes with `encoding: 'utf8'`. When a poll
 * lands mid-character — which it will, because the agent writes continuously and
 * we read whatever exists at that instant — the trailing bytes of that character
 * are decoded on their own and the leading bytes on the next pass.
 *
 * This matters in practice, not theory: grok output is full of em-dashes,
 * arrows, checkmarks and emoji.
 *
 * Written before the fix, to establish whether it is real (directive D1).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, appendFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionObserver } from '../src/daemon/observer.ts';
import type { RcEvent } from '../src/daemon/events.ts';

/** One log line carrying the given agent text. */
const line = (text: string) =>
  JSON.stringify({
    timestamp: 1,
    method: 'session/update',
    params: {
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  }) + '\n';

async function collectSplit(text: string, splitAtByte: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'obs-utf8-'));
  const file = join(dir, 'updates.jsonl');
  const full = Buffer.from(line(text), 'utf8');

  // Write the first part — deliberately cutting a multi-byte character in half.
  await writeFile(file, full.subarray(0, splitAtByte));

  const seen: RcEvent[] = [];
  const obs = new SessionObserver({ sessionDir: dir, pollMs: 20 });
  obs.on('event', (e) => seen.push(e));
  await obs.start();
  await new Promise((r) => setTimeout(r, 120)); // let it read the partial

  // Now the rest arrives, exactly as a live writer would append it.
  const fh = await open(file, 'a');
  await fh.write(full.subarray(splitAtByte));
  await fh.close();
  await new Promise((r) => setTimeout(r, 250));

  obs.stop();
  await rm(dir, { recursive: true, force: true });

  return seen
    .filter((e): e is Extract<RcEvent, { k: 'text' }> => e.k === 'text')
    .map((e) => e.text)
    .join('');
}

test('an em-dash split across a read boundary survives intact', async () => {
  const text = 'done — created hello.txt';
  const bytes = Buffer.from(line(text), 'utf8');
  // Land the split inside the em-dash (U+2014, 3 bytes in UTF-8).
  const dashAt = bytes.indexOf(Buffer.from('—', 'utf8'));
  assert.ok(dashAt > 0, 'em-dash must be present in the fixture');

  const got = await collectSplit(text, dashAt + 1); // one byte into the dash
  assert.equal(got, text, `text corrupted across the boundary: ${JSON.stringify(got)}`);
});

test('an emoji split across a read boundary survives intact', async () => {
  const text = 'build passed ✅ shipping';
  const bytes = Buffer.from(line(text), 'utf8');
  const at = bytes.indexOf(Buffer.from('✅', 'utf8'));
  assert.ok(at > 0);

  const got = await collectSplit(text, at + 2); // two bytes into a 3-byte char
  assert.equal(got, text, `text corrupted across the boundary: ${JSON.stringify(got)}`);
});

test('a 4-byte character (outside the BMP) survives a boundary', async () => {
  const text = 'deploy 🚀 now';
  const bytes = Buffer.from(line(text), 'utf8');
  const at = bytes.indexOf(Buffer.from('🚀', 'utf8'));
  assert.ok(at > 0);

  const got = await collectSplit(text, at + 3); // three bytes into a 4-byte char
  assert.equal(got, text, `text corrupted across the boundary: ${JSON.stringify(got)}`);
});

test('plain ASCII across a boundary is unaffected', async () => {
  // Control: proves the harness itself splits and reassembles correctly.
  const text = 'plain ascii only';
  const got = await collectSplit(text, 40);
  assert.equal(got, text);
});
