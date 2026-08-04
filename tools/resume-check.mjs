#!/usr/bin/env node
/**
 * Resume check — the bug the owner hit.
 *
 * A session you started through the app became permanently read-only once its
 * process ended: you could read the transcript but never continue it. Grok
 * advertises `loadSession: true`, so that was our limitation, not the agent's.
 *
 * This proves the whole loop with a REAL agent and a REAL browser:
 *   1. start a session, say something the agent must remember
 *   2. kill the session so it is only history on disk
 *   3. reopen it — it must show as read-only with a Resume affordance
 *   4. resume, and verify the composer returns
 *   5. ask the agent to recall the earlier fact — proving context survived
 *
 * Costs a little quota.
 *
 *   npm run build && node tools/resume-check.mjs
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'docs/screenshots');
const cfgDir = await mkdtemp(join(tmpdir(), 'grokrc-resume-cfg-'));
process.env.GROKRC_HOME = cfgDir;

const { AuthStore } = await import('../dist/daemon/auth.js');
const { SessionManager } = await import('../dist/daemon/session-manager.js');
const { RemoteControlServer } = await import('../dist/daemon/server.js');

const workDir = await mkdtemp(join(tmpdir(), 'grokrc-resume-work-'));
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

const problems = [];
const note = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) problems.push(msg);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

const MAGIC = 'PURPLE-ELEPHANT-77';

try {
  await mkdir(SHOTS, { recursive: true });

  const { code } = auth.beginPairing();
  await page.goto(base);
  await page.fill('#code', code);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 20_000 });

  /* 1. start a session and plant a fact */
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 20_000 });
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
  const sessionId = sessions.list()[0]?.id;
  note(!!sessionId, `session created (${sessionId})`);
  console.log('  · planted codeword, closing the session…');

  /* 2. kill it — now it exists only as history on disk */
  sessions.close(sessionId);
  await new Promise((r) => setTimeout(r, 1200));

  /* 3. reopen from the list — must be read-only, with a way back in */
  await page.click('#back');
  await page.waitForSelector('#v-list.on', { timeout: 15_000 });
  await page.waitForFunction((id) => !!document.querySelector('.session'), sessionId, {
    timeout: 15_000,
  });
  // Click the row for our session (top of the list — most recently updated).
  await page.click('.session');
  await page.waitForSelector('#v-session.on', { timeout: 15_000 });

  const composerHiddenBefore = await page.evaluate(
    () => document.getElementById('composer').hidden
  );
  note(composerHiddenBefore, 'past session opens read-only (composer hidden)');

  const hasResume = await page.$('[data-resume] button');
  note(!!hasResume, 'a Resume affordance is offered');
  await page.screenshot({ path: join(SHOTS, 'resume-bar.png'), fullPage: true });

  /* 4. resume it */
  await page.click('[data-resume] button');
  await page.waitForFunction(
    () => document.getElementById('composer').hidden === false,
    undefined,
    { timeout: 60_000 }
  );
  note(true, 'composer returns after resuming');
  const barGone = await page.$('[data-resume]');
  note(!barGone, 'resume bar disappears once live');

  /* 5. does the agent still remember? */
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

  // A Send button stuck on "Stop" means the turn never reported completion, and
  // the user is left unsure whether the agent is still working.
  const backToSend = await page
    .waitForFunction(
      () => document.getElementById('send').textContent.trim() === 'Send',
      undefined,
      {
        timeout: 45_000,
      }
    )
    .then(() => true)
    .catch(() => false);
  note(backToSend, 'send button resets to "Send" once the turn ends');

  await page.screenshot({ path: join(SHOTS, 'resumed-session.png'), fullPage: true });
} catch (err) {
  problems.push(`FAILED: ${err.message}`);
  await page.screenshot({ path: join(SHOTS, 'resume-error.png'), fullPage: true }).catch(() => {});
} finally {
  console.log(`\n─── ${problems.length ? problems.length + ' PROBLEM(S)' : 'ALL CLEAR'} ───`);
  for (const p of problems) console.log(`  · ${p}`);
  await browser.close();
  sessions.closeAll();
  await server.close();
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  await rm(cfgDir, { recursive: true, force: true }).catch(() => {});
  process.exit(problems.length ? 1 : 0);
}
