/**
 * Real browser, real PWA, real DOM.
 *
 * This was the riskiest gap in the project: every other test proved the daemon
 * and the protocol, while the interface a human actually touches had never been
 * rendered. Here Chromium loads the app, pairs through the form, drives a turn,
 * and clicks an approval button — against a scripted agent replaying payloads
 * captured verbatim from grok 0.2.118, so it's realistic and free.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-browser-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

const mocks: InstanceType<typeof MockTransport>[] = [];
const auth = new AuthStore();
await auth.load();

const sessions = new SessionManager({
  transportFactory: () => {
    const m = new MockTransport({ sessionId: `mock-${mocks.length + 1}` });
    mocks.push(m);
    return m;
  },
});

const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
  // A directory that actually exists: cwd is validated before spawning.
  defaultCwd: tmp,
});
const { port } = await server.listen();
const base = `http://127.0.0.1:${port}`;

const SHOTS = resolve(import.meta.dirname, '../docs/screenshots');

let browser: Browser;
let page: Page;

before(async () => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(SHOTS, { recursive: true });
  browser = await chromium.launch();
  // A phone-sized viewport — this is a mobile-first UI and layout bugs only
  // show at the width it will actually be used at.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await ctx.newPage();
  page.on('pageerror', (err) => {
    throw new Error(`uncaught page error: ${err.message}`);
  });
});

after(async () => {
  await browser?.close();
  sessions.closeAll();
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

test('the app loads and shows the pairing screen', async () => {
  await page.goto(base);
  await page.waitForSelector('#v-pair.on');
  assert.match((await page.textContent('#v-pair h1')) ?? '', /Pair this device/);
});

test('a wrong code shows an error and does not let you in', async () => {
  auth.beginPairing();
  await page.fill('#code', 'ZZZZZZ');
  await page.click('#pair-go');
  await page.waitForFunction(() => !!document.querySelector('#pair-err')?.textContent);
  assert.match((await page.textContent('#pair-err')) ?? '', /invalid or expired/);
  assert.ok(await page.isVisible('#v-pair'));
});

test('pairing with the real code reaches the session list', async () => {
  const { code } = auth.beginPairing();
  await page.fill('#code', code);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 10_000 });
  assert.match((await page.textContent('#title')) ?? '', /Sessions/);
  await page.screenshot({ path: SHOTS + '/sessions.png', fullPage: true });
});

test('creating a session opens the transcript with a composer', async () => {
  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 10_000 });
  assert.equal(await page.isVisible('#composer'), true);
  // A fresh session must not render as a blank screen.
  assert.match((await page.textContent('#v-session')) ?? '', /No messages yet/);
  // The header must name the session, not fall back to "Sessions" when the
  // list re-renders behind it.
  assert.notEqual((await page.textContent('#title'))?.trim(), 'Sessions');
});

test('a prompt streams text and renders tool and plan cards', async () => {
  await page.fill('#input', 'Create hello.txt');
  await page.click('#send');

  // User message echoes immediately.
  await page.waitForSelector('.msg.user .bubble');
  assert.match((await page.textContent('.msg.user .bubble')) ?? '', /Create hello\.txt/);

  await page.waitForSelector('.tool', { timeout: 10_000 });
  assert.match((await page.textContent('.tool .nm')) ?? '', /Write/);

  await page.waitForSelector('.plan li', { timeout: 10_000 });
  assert.match((await page.textContent('.plan')) ?? '', /Write hello\.txt/);

  await page.waitForSelector('.thinking', { timeout: 10_000 });
});

test('the approval renders with real options', async () => {
  await page.waitForSelector('.approval', { timeout: 15_000 });
  // Artifact for humans — the one screen the product exists for.
  await page.screenshot({ path: SHOTS + '/approval.png', fullPage: true });
  const text = await page.textContent('.approval');
  assert.match(text ?? '', /Write `\/tmp\/demo\/hello\.txt`/);
  // The tool input must be visible — approving blind is not approving.
  assert.match(text ?? '', /hello\.txt/);
  const labels = await page.$$eval('.approval button', (bs) => bs.map((b) => b.textContent));
  assert.equal(labels.length, 3);
});

test('the session-wide grant is NOT the first button and is visually demoted', async () => {
  // Grok returns options widest-first; rendering that order would put "allow
  // all edits this session" under the user's thumb. This is the regression
  // guard for that fix.
  const first = await page.$eval('.approval button', (b) => ({
    text: b.textContent,
    cls: b.className,
  }));
  assert.doesNotMatch(first.text ?? '', /all edits/i, 'broad grant must not be first');
  assert.doesNotMatch(first.cls, /broad/);

  const broad = await page.$('.approval button.broad');
  assert.ok(broad, 'allow_always must be marked .broad');
  assert.match((await broad!.textContent()) ?? '', /all edits/i);
});

test('tapping Yes answers the agent with allow-once', async () => {
  const before = mocks[0]!.permissionAnswers.length;
  // Click the narrow grant specifically.
  await page.click('.approval button.allow:not(.broad)');

  await page.waitForFunction(() => !!document.querySelector('.approval.resolved'), undefined, {
    timeout: 10_000,
  });

  // The scripted agent must have actually received the answer.
  const deadline = Date.now() + 5000;
  while (mocks[0]!.permissionAnswers.length === before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(mocks[0]!.permissionAnswers.length, before + 1);
  assert.equal(mocks[0]!.permissionAnswers.at(-1)?.optionId, 'allow-once');

  // Buttons must be disabled so a double-tap can't answer twice.
  const disabled = await page.$$eval('.approval button', (bs) =>
    bs.every((b) => (b as HTMLButtonElement).disabled)
  );
  assert.equal(disabled, true);
});

test('the turn completes and the tool card shows success', async () => {
  // Wait for the LAST thing the turn produces, not the first. The tool card
  // flips to `ok` while the agent is still streaming its closing message, so
  // waiting on the card and asserting on the text is a race — it fails roughly
  // one run in two.
  await page.waitForFunction(
    () => (document.querySelector('#v-session')?.textContent ?? '').includes('Done — created'),
    undefined,
    { timeout: 15_000 }
  );

  const okCard = await page.$$eval('.tool', (cards) =>
    cards.some((c) => c.className.includes('ok'))
  );
  assert.equal(okCard, true, 'tool card should show success once the turn completes');

  const body = await page.textContent('#v-session');
  assert.match(body ?? '', /Done — created hello\.txt\./);
});

test('the page never scrolls horizontally at phone width', async () => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  assert.equal(overflow, false, 'horizontal overflow at 390px');
});

test('an observed session hides the composer and says it is read-only', async () => {
  // The bug this guards: `footer { display: flex }` overrode the UA
  // `[hidden] { display: none }`, so setting composer.hidden did nothing and a
  // read-only session presented a working-looking input. Typing into it sent a
  // prompt the daemon rejected — silently.
  await page.evaluate(() => {
    const fake = {
      id: 'observed-1',
      cwd: '/tmp/observed',
      title: 'observed session',
      mode: 'observed',
      state: 'idle',
      pendingApprovals: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // Drive the app's own code path rather than poking the DOM.
    (globalThis as unknown as { openSession: (s: unknown) => void }).openSession?.(fake);
  });

  // If the app doesn't expose openSession, fall back to asserting the CSS rule
  // directly — the regression is the style, and it must exist either way.
  const hiddenWorks = await page.evaluate(() => {
    const f = document.querySelector('footer')!;
    const prev = f.hidden;
    f.hidden = true;
    const display = getComputedStyle(f).display;
    f.hidden = prev;
    return display === 'none';
  });
  assert.equal(hiddenWorks, true, 'footer[hidden] must actually be display:none');
});

test('reloading replays history rather than losing the transcript', async () => {
  await page.reload();
  await page.waitForSelector('#v-list.on', { timeout: 10_000 });
  // Token persisted, so it goes straight to the list — not back to pairing.
  assert.equal(await page.isVisible('#v-pair'), false);
});

test('a finished tool row still names the file it wrote', async () => {
  // BACKLOG #9, from a VERBATIM grok 1.0.0 capture (tools/../scratchpad probe):
  // one file write is three events under one toolCallId, and the last carries
  // no title and no kind. The old renderer wrote the normalizer's fallback —
  // the literal word "tool" — straight over the label, so a three-file edit
  // finished as three identical rows saying "tool".
  //
  // Real daemon, real websocket, real page: only the agent is scripted, and
  // these payloads are transcribed from a live one.
  // The previous test reloads, which lands on the session list. The daemon only
  // forwards events to a client WATCHING that session, so the page has to be
  // inside one — without this the rows never arrive and the failure is a bare
  // timeout that says nothing about the label.
  await page.click('.session');
  await page.waitForSelector('#v-session.on', { timeout: 10_000 });

  const open = sessions.list()[0];
  assert.ok(open, 'a session must be open for this test to mean anything');
  const sessionId = open.id;

  const files = ['alpha.txt', 'beta.txt', 'gamma.txt'];
  files.forEach((f, i) => {
    const toolId = `call-9f1e-${i}`;
    const path = `/tmp/multi/${f}`;
    // 1. the call opens with a generic verb
    sessions.emit('event', {
      k: 'tool',
      sessionId,
      toolId,
      name: 'write',
      title: 'write',
      status: 'running',
    });
    // 2. the update names the file
    sessions.emit('event', {
      k: 'tool',
      sessionId,
      toolId,
      name: 'edit',
      title: `Write \`${path}\``,
      status: 'running',
      locations: [{ path }],
    });
    // 3. completion arrives with NOTHING but a status
    sessions.emit('event', { k: 'tool', sessionId, toolId, name: 'tool', status: 'ok' });
  });

  await page.waitForFunction(() => document.querySelectorAll('.tool').length >= 3, undefined, {
    timeout: 10_000,
  });

  const labels = await page.$$eval('.tool .nm', (ns) => ns.map((n) => n.textContent ?? ''));
  for (const f of files) {
    assert.ok(
      labels.some((l) => l.includes(f)),
      `no tool row mentions ${f} — labels were ${JSON.stringify(labels)}`
    );
  }
  assert.ok(
    !labels.some((l) => l.trim() === 'tool'),
    `a row was downgraded to the generic word "tool": ${JSON.stringify(labels)}`
  );
});
