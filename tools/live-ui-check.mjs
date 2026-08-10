#!/usr/bin/env node
/**
 * Live UI check — real browser, REAL agent, real prompt.
 *
 * The mock-backed browser tests replay captured payloads: fast, deterministic,
 * and blind to anything about how a live agent *streams*. Both bugs the owner hit
 * — thinking rendered one word per block, and every prompt posted twice — were
 * invisible to the mock, which does not stream thinking token-by-token and does
 * not echo `user_message_chunk`.
 *
 * Asserts what a human would notice. Costs a small amount of xAI quota.
 *
 *   npm run build && node tools/live-ui-check.mjs
 */
import { join } from 'node:path';
import {
  bootDaemon,
  isolatedGrokHome,
  pairedPage,
  reporter,
  cleanup,
  skipWithoutAgent,
  SHOTS,
} from './harness.mjs';

const { note, problems, finish } = reporter();
if (await skipWithoutAgent('live UI check')) process.exit(0);

// Own GROK_HOME: a real agent writes session history that outlives this
// run, and it must not land in the owner's ~/.grok.
await isolatedGrokHome({ prompting: false });
const daemon = await bootDaemon(); // no transportFactory ⇒ REAL grok
const ui = await pairedPage({ base: daemon.base, auth: daemon.auth });
const { page } = ui;

try {
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 25_000 });

  const PROMPT = 'hi, how are you?';
  await page.fill('#input', PROMPT);
  await page.click('#send');
  console.log(`\nprompt sent: "${PROMPT}"\nwaiting for the agent…\n`);

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.msg.agent .bubble')].some(
        (b) => (b.textContent ?? '').trim().length > 15
      ),
    undefined,
    { timeout: 180_000 }
  );
  await new Promise((r) => setTimeout(r, 2500)); // let streaming settle
  await page.screenshot({ path: join(SHOTS, 'live-turn.png'), fullPage: true });

  /* ─── what a human would notice ────────────────────────────────────────── */

  const userBubbles = await page.$$eval('.msg.user .bubble', (b) =>
    b.map((x) => x.textContent?.trim())
  );
  const echoes = userBubbles.filter((t) => t === PROMPT).length;
  note(echoes === 1, `prompt appears exactly once (found ${echoes})`);

  const thinkingCount = await page.$$eval('.thinking', (n) => n.length);
  note(thinkingCount <= 2, `thinking rendered as ${thinkingCount} block(s), not one per word`);

  if (thinkingCount) {
    const words = await page.$$eval('.thinking', (n) =>
      n.map((x) => (x.textContent ?? '').trim().split(/\s+/).length)
    );
    note(
      Math.max(...words) > 3,
      `thinking blocks hold full text (largest ${Math.max(...words)} words)`
    );

    // Streamed chunks plus the coalesced flush both landing printed the whole
    // reasoning twice inside one block.
    const dupes = await page.$$eval('.thinking', (n) =>
      n
        .map((x) => (x.textContent ?? '').trim())
        .filter((t) => t.length > 80)
        .filter((t) => t.indexOf(t.slice(0, 40), 1) !== -1)
    );
    note(dupes.length === 0, `no thinking block repeats itself (${dupes.length} duplicated)`);
  }

  const byteDump = await page.$$eval(
    '.tool pre',
    (n) => n.filter((x) => /\d+,\s*\n\s+\d+,/.test(x.textContent ?? '')).length
  );
  note(byteDump === 0, `tool output is readable, not a raw byte array (${byteDump} dumps)`);

  const agentText = await page.$$eval('.msg.agent .bubble', (b) =>
    b.map((x) => (x.textContent ?? '').trim()).filter(Boolean)
  );
  note(agentText.length > 0, `agent replied (${agentText.length} message block(s))`);
  note(new Set(agentText).size === agentText.length, 'no duplicated agent message blocks');

  const toolCount = await page.$$eval('.tool', (n) => n.length);
  note(
    agentText.length <= toolCount + 1,
    `reply not fragmented (${agentText.length} bubbles for ${toolCount} tool call(s))`
  );

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  note(!overflow, 'no horizontal overflow at phone width');

  const capped = await page.$$eval('.thinking', (n) =>
    n.every((x) => x.getBoundingClientRect().height < 400)
  );
  note(capped, 'thinking blocks are height-capped');

  console.log('\n  reply preview:');
  for (const t of agentText.slice(0, 3)) console.log(`    "${t.slice(0, 110)}"`);
} catch (err) {
  problems.push(`FAILED: ${err.message}`);
  await page
    .screenshot({ path: join(SHOTS, 'live-turn-error.png'), fullPage: true })
    .catch(() => {});
} finally {
  const code = finish();
  console.log(`\nscreenshot -> docs/screenshots/live-turn.png`);
  await ui.close();
  await daemon.close();
  await cleanup();
  process.exit(code);
}
