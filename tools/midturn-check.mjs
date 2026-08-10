#!/usr/bin/env node
/**
 * Does a turn killed mid-flight survive a resume?
 *
 * BACKLOG #19. The README claimed "resuming replays from the agent and recovers
 * it" as fact. Nothing tested it, and **Take over kills the agent mid-turn by
 * design** — so this is the main path, not an edge case. The owner hit it
 * taking over a live session and lost the tail of a reply, and was told to
 * prompt again as though that were expected.
 *
 * The check: stream a real turn, kill the agent while text is still arriving,
 * resume, and compare what the resumed history contains against what was
 * actually observed on the wire before the kill.
 *
 * There is no mock here. The question is what GROK persists and when, which
 * only a real agent can answer.
 */
import { isolatedGrokHome, bootDaemon, reporter, cleanup, skipWithoutAgent } from './harness.mjs';

if (await skipWithoutAgent('mid-turn recovery check')) process.exit(0);

const { note, finish } = reporter();

await isolatedGrokHome({ prompting: false });
const daemon = await bootDaemon(); // REAL grok

const cwd = process.env.MIDTURN_CWD ?? (await import('node:os')).tmpdir();
const info = await daemon.sessions.create(cwd, { title: 'midturn' });
note(!!info.id, `session created (${info.id})`);

/** Everything the daemon emitted for this session, in order. */
const streamed = [];
const streamedKinds = {};
daemon.sessions.on('event', (ev) => {
  if (ev.sessionId !== info.id) return;
  streamedKinds[ev.k] = (streamedKinds[ev.k] ?? 0) + 1;
  if (ev.k === 'error') console.log(`  [agent error] ${ev.message}`);
  // ONLY agent text. The user's own prompt is echoed back as role:'user', and
  // counting it made the wait loop exit before the agent had said a word — so
  // the kill landed before any output existed and "nothing survived" was
  // guaranteed by the harness, not by the product.
  if (ev.k === 'text' && ev.role === 'agent') streamed.push(ev.text ?? '');
});

// A long, strictly-ordered answer: the numbers make it obvious how far the
// turn got, and how much of it survived.
const PROMPT =
  'Count from 1 to 120, one number per line, nothing else. Start immediately.';
void daemon.sessions.prompt(info.id, PROMPT).catch(() => {});

// Wait until the turn is genuinely in flight — killing before any output would
// test nothing.
const deadline = Date.now() + 60_000;
while (streamed.join('').length < 40 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
}
if (streamed.join('').length === 0) {
  note(false, 'the agent produced no text before the timeout — nothing to kill mid-turn');
  daemon.sessions.closeAll();
  await daemon.close();
  await cleanup();
  finish();
}
const beforeKill = streamed.join('');
note(beforeKill.length > 0, `turn is streaming (${beforeKill.length} chars captured)`);

// Kill the agent the way Take over does.
const owner = (await daemon.sessions.activeOnDisk()).find((a) => a.sessionId === info.id);
const pid = owner?.pid;
if (pid) {
  process.kill(pid, 'SIGTERM');
  note(true, `agent pid ${pid} sent SIGTERM mid-turn`);
} else {
  // Session is owned in-process; close it, which tears the agent down the same way.
  daemon.sessions.close(info.id);
  note(true, 'agent closed mid-turn (owned in-process)');
}
await new Promise((r) => setTimeout(r, 2500));

// Resume, exactly as the phone would.
let resumedOk = true;
try {
  await daemon.sessions.resume(info.id, cwd);
} catch (err) {
  resumedOk = false;
  note(false, `resume failed: ${err.message}`);
}

if (resumedOk) {
  await new Promise((r) => setTimeout(r, 2500));
  const raw = daemon.sessions.history(info.id);
  const kinds = {};
  for (const e of raw) kinds[e.k] = (kinds[e.k] ?? 0) + 1;
  console.log(`  resumed history: ${raw.length} event(s), kinds: ${JSON.stringify(kinds)}`);
  console.log(`  streamed kinds during the turn: ${JSON.stringify(streamedKinds)}`);

  const history = daemon.sessions
    .history(info.id)
    .filter((e) => e.k === 'text' && e.role === 'agent')
    .map((e) => e.text ?? '')
    .join('');

  note(history.length > 0, `resumed history is not empty (${history.length} chars)`);

  // The decisive comparison: the last thing seen before the kill must still be
  // there afterwards.
  const tail = beforeKill.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
  const survived = tail !== '' && history.includes(tail);
  note(survived, `the last streamed line (${JSON.stringify(tail)}) survived the resume`);

  if (!survived) {
    console.log(`\n  streamed before kill (tail): ${JSON.stringify(beforeKill.slice(-160))}`);
    console.log(`  resumed history      (tail): ${JSON.stringify(history.slice(-160))}\n`);
  }
}

daemon.sessions.closeAll();
await daemon.close();
await cleanup();
finish();
