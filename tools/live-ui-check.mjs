#!/usr/bin/env node
/**
 * Live UI check — real browser, real agent, real prompt.
 *
 * The mock-backed browser tests replay captured payloads, which is fast and
 * deterministic but cannot catch bugs in how a LIVE agent actually streams.
 * Both bugs the owner hit — thinking rendering one word per block, and the
 * prompt appearing twice — were invisible to the mock because the mock doesn't
 * stream thinking token-by-token and doesn't echo user_message_chunk.
 *
 * This drives the genuine article and asserts what a human would notice.
 * Costs a small amount of xAI quota.
 *
 *   npm run build && node tools/live-ui-check.mjs
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'docs/screenshots');

const cfgDir = await mkdtemp(join(tmpdir(), 'grokrc-liveui-'));
process.env.GROKRC_HOME = cfgDir;

const { AuthStore } = await import('../dist/daemon/auth.js');
const { SessionManager } = await import('../dist/daemon/session-manager.js');
const { RemoteControlServer } = await import('../dist/daemon/server.js');

const workDir = await mkdtemp(join(tmpdir(), 'grokrc-liveui-work-'));
const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager(); // REAL grok, no mock
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
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
});

try {
  await mkdir(SHOTS, { recursive: true });

  const { code } = auth.beginPairing();
  await page.goto(base);
  await page.fill('#code', code);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 20_000 });
  console.log('paired\n');

  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 20_000 });

  const PROMPT = 'hi, how are you?';
  await page.fill('#input', PROMPT);
  await page.click('#send');
  console.log(`prompt sent: "${PROMPT}"`);
  console.log('waiting for the agent…\n');

  // Wait for a finished agent reply, not just any text.
  await page.waitForFunction(
    () => {
      const bubbles = [...document.querySelectorAll('.msg.agent .bubble')];
      return bubbles.some((b) => (b.textContent ?? '').trim().length > 15);
    },
    undefined,
    { timeout: 180_000 }
  );
  await new Promise((r) => setTimeout(r, 2500)); // let streaming settle

  await page.screenshot({ path: join(SHOTS, 'live-turn.png'), fullPage: true });

  /* ─── the assertions a human would make ─────────────────────────────── */

  const userBubbles = await page.$$eval('.msg.user .bubble', (b) =>
    b.map((x) => x.textContent?.trim())
  );
  note(
    userBubbles.filter((t) => t === PROMPT).length === 1,
    `prompt appears exactly once (found ${userBubbles.filter((t) => t === PROMPT).length})`
  );

  const thinkingCount = await page.$$eval('.thinking', (n) => n.length);
  note(thinkingCount <= 2, `thinking rendered as ${thinkingCount} block(s), not one per word`);

  if (thinkingCount) {
    const words = await page.$$eval('.thinking', (n) =>
      n.map((x) => (x.textContent ?? '').trim().split(/\s+/).length)
    );
    note(
      Math.max(...words) > 3,
      `thinking blocks contain full text (largest has ${Math.max(...words)} words)`
    );

    // The streamed chunks plus the coalesced flush used to both land, printing
    // the whole reasoning twice inside one block.
    const dupes = await page.$$eval('.thinking', (n) =>
      n
        .map((x) => (x.textContent ?? '').trim())
        .filter((t) => t.length > 80)
        .filter((t) => {
          const head = t.slice(0, 40);
          return t.indexOf(head, 1) !== -1;
        })
    );
    note(dupes.length === 0, `no thinking block repeats itself (${dupes.length} duplicated)`);
  }

  const byteDump = await page.$$eval('.tool pre', (n) =>
    n.filter((x) => /\d+,\s*\n\s+\d+,/.test(x.textContent ?? '')).length
  );
  note(byteDump === 0, `tool output is readable, not a raw byte array (${byteDump} dumps)`);

  const agentText = await page.$$eval('.msg.agent .bubble', (b) =>
    b.map((x) => (x.textContent ?? '').trim()).filter(Boolean)
  );
  note(agentText.length > 0, `agent replied (${agentText.length} message block(s))`);
  note(
    new Set(agentText).size === agentText.length,
    'no duplicated agent message blocks'
  );
  // A single reply used to be chopped into several bubbles because metadata
  // events arriving mid-stream triggered a flush.
  const toolCount = await page.$$eval('.tool', (n) => n.length);
  note(
    agentText.length <= toolCount + 1,
    `reply not fragmented (${agentText.length} bubbles for ${toolCount} tool call(s))`
  );

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  note(!overflow, 'no horizontal overflow at phone width');

  const thinkTall = await page.$$eval('.thinking', (n) =>
    n.every((x) => x.getBoundingClientRect().height < 400)
  );
  note(thinkTall, 'thinking blocks are height-capped');

  console.log('\n  reply preview:');
  for (const t of agentText.slice(0, 3)) console.log(`    "${t.slice(0, 110)}"`);
} catch (err) {
  problems.push(`FAILED: ${err.message}`);
  await page.screenshot({ path: join(SHOTS, 'live-turn-error.png'), fullPage: true }).catch(() => {});
} finally {
  console.log(`\n─── ${problems.length ? problems.length + ' PROBLEM(S)' : 'ALL CLEAR'} ───`);
  for (const p of problems) console.log(`  · ${p}`);
  console.log(`\nscreenshot -> docs/screenshots/live-turn.png`);

  await browser.close();
  sessions.closeAll();
  await server.close();
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  await rm(cfgDir, { recursive: true, force: true }).catch(() => {});
  process.exit(problems.length ? 1 : 0);
}
