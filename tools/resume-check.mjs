#!/usr/bin/env node
/**
 * Resume check — the bug the owner hit.
 *
 * A session started through the app became permanently read-only once its
 * process ended: readable, never continuable. Grok advertises `loadSession`, so
 * that was our limitation, not the agent's.
 *
 * Proves the whole loop against a REAL agent in a REAL browser:
 *   1. start a session, plant a codeword the agent must remember
 *   2. kill it, so it exists only as history on disk
 *   3. reopen — must be read-only, and must offer Resume
 *   4. resume — the composer must return
 *   5. ask for the codeword — proving context genuinely survived
 *
 *   npm run build && node tools/resume-check.mjs
 */
import { join } from 'node:path';
import { bootDaemon, isolatedGrokHome, pairedPage, reporter, cleanup, SHOTS } from './harness.mjs';

const MAGIC = 'PURPLE-ELEPHANT-77';
const { note, problems, finish } = reporter();

// Own GROK_HOME: a real agent writes session history that outlives this
// run, and it must not land in the owner's ~/.grok.
await isolatedGrokHome({ prompting: false });
const daemon = await bootDaemon(); // REAL grok
const ui = await pairedPage({ base: daemon.base, auth: daemon.auth });
const { page } = ui;

try {
  /* 1 — plant a fact */
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 25_000 });
  await page.fill('#input', `Remember this codeword exactly: ${MAGIC}. Just acknowledge it.`);
  await page.click('#send');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.msg.agent .bubble')].some(
        (b) => (b.textContent ?? '').trim().length > 5
      ),
    undefined,
    { timeout: 180_000 }
  );

  const sessionId = daemon.sessions.list()[0]?.id;
  note(!!sessionId, `session created (${sessionId})`);
  console.log('  · planted codeword, closing the session…');

  /* 2 — kill it; now only history on disk */
  daemon.sessions.close(sessionId);
  await new Promise((r) => setTimeout(r, 1200));

  /* 3 — reopen: read-only, with a way back in */
  await page.click('#back');
  await page.waitForSelector('#v-list.on', { timeout: 15_000 });
  await page.waitForFunction(() => !!document.querySelector('.session'), undefined, {
    timeout: 15_000,
  });
  await page.click('.session');
  await page.waitForSelector('#v-session.on', { timeout: 15_000 });

  note(
    await page.evaluate(() => document.getElementById('composer').hidden),
    'past session opens read-only (composer hidden)'
  );
  note(!!(await page.$('[data-resume] button')), 'a Resume affordance is offered');
  await page.screenshot({ path: join(SHOTS, 'resume-bar.png'), fullPage: true });

  /* 4 — resume */
  await page.click('[data-resume] button');
  await page.waitForFunction(
    () => document.getElementById('composer').hidden === false,
    undefined,
    { timeout: 60_000 }
  );
  note(true, 'composer returns after resuming');
  note(!(await page.$('[data-resume]')), 'resume bar disappears once live');

  /* 5 — does the agent still remember? */
  await page.fill(
    '#input',
    'What was the codeword I asked you to remember? Reply with just the codeword.'
  );
  await page.click('#send');
  await page
    .waitForFunction(
      (magic) =>
        [...document.querySelectorAll('.msg.agent .bubble')].some((b) =>
          (b.textContent ?? '').includes(magic)
        ),
      MAGIC,
      { timeout: 180_000 }
    )
    .catch(() => {});

  const recalled = await page.$$eval(
    '.msg.agent .bubble',
    (b, magic) => b.some((x) => (x.textContent ?? '').includes(magic)),
    MAGIC
  );
  note(recalled, `agent recalled the codeword across the resume (${MAGIC})`);

  // A Send button stuck on "Stop" leaves the user unsure whether it is still working.
  const backToSend = await page
    .waitForFunction(
      () => document.getElementById('send').textContent.trim() === 'Send',
      undefined,
      { timeout: 45_000 }
    )
    .then(() => true)
    .catch(() => false);
  note(backToSend, 'send button resets to "Send" once the turn ends');

  await page.screenshot({ path: join(SHOTS, 'resumed-session.png'), fullPage: true });
} catch (err) {
  problems.push(`FAILED: ${err.message}`);
  await page.screenshot({ path: join(SHOTS, 'resume-error.png'), fullPage: true }).catch(() => {});
} finally {
  const code = finish();
  await ui.close();
  await daemon.close();
  await cleanup();
  process.exit(code);
}
