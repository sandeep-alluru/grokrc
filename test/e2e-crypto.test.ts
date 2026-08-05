/**
 * End-to-end encryption through the relay.
 *
 * The load-bearing test is `the relay never sees plaintext`: it taps every frame
 * the relay forwards and asserts the prompt text, the pairing code, and the
 * device token appear nowhere in them. That is the claim the docs make, so it is
 * the claim that has to be mechanically checked — a previous version of this
 * project asserted zero-knowledge in prose while forwarding cleartext.
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { deriveKey, seal, open, isEnvelope, randomSecret } from '../web/crypto.js';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-e2ecrypto-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');
const { RelayServer } = await import('../src/relay/server.ts');
const { MockTransport } = await import('../src/acp/mock-transport.ts');

/* ─── the primitives ──────────────────────────────────────────────────────── */

test('seal/open round-trips', async () => {
  const key = await deriveKey(randomSecret());
  const env = await seal(key, 'hello grok');
  assert.ok(isEnvelope(env));
  assert.equal(await open(key, env), 'hello grok');
});

test('ciphertext does not contain the plaintext', async () => {
  const key = await deriveKey(randomSecret());
  const env = await seal(key, 'SECRET-MARKER-9931');
  assert.doesNotMatch(JSON.stringify(env), /SECRET-MARKER-9931/);
});

test('a different secret cannot decrypt', async () => {
  const a = await deriveKey(randomSecret());
  const b = await deriveKey(randomSecret());
  const env = await seal(a, 'private');
  await assert.rejects(() => open(b, env));
});

test('tampering is detected, not silently decrypted', async () => {
  // AES-GCM authenticates; a flipped byte must throw rather than yield garbage.
  const key = await deriveKey(randomSecret());
  const env = await seal(key, 'important');
  const bytes = [...env.c];
  bytes[0] = bytes[0] === 'A' ? 'B' : 'A';
  await assert.rejects(() => open(key, { ...env, c: bytes.join('') }));
});

test('nonces differ across messages', async () => {
  const key = await deriveKey(randomSecret());
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) seen.add((await seal(key, 'same plaintext')).n);
  assert.equal(seen.size, 25);
});

/* ─── through the real relay, in a real browser ───────────────────────────── */

const WEB = resolve(import.meta.dirname, '../web');
const ROOM = 'cryptoroom';
const KEY = 'cryptokey';
const SECRET = randomBytes(32).toString('base64url');
const PROMPT_MARKER = 'PLAINTEXT-CANARY-4417';

/** Every frame the relay handled, in both directions — captured at the relay itself. */
const relayTraffic: string[] = [];

const relay = new RelayServer({ webRoot: WEB, onFrame: (raw) => relayTraffic.push(raw) });
const relayPort = await relay.listen(0, '127.0.0.1');

const mocks: InstanceType<typeof MockTransport>[] = [];
const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager({
  transportFactory: () => {
    const m = new MockTransport({ sessionId: `crypto-mock-${mocks.length + 1}` });
    mocks.push(m);
    return m;
  },
});

const daemon = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: WEB,
  sessions,
  auth,
  // A directory that actually exists: cwd is validated before spawning.
  defaultCwd: tmp,
});
await daemon.listen();

daemon.connectRelay({ url: `ws://127.0.0.1:${relayPort}`, room: ROOM, key: KEY, secret: SECRET });
await new Promise((r) => setTimeout(r, 400));

const relayBase = `http://127.0.0.1:${relayPort}`;
let browser: Browser;
let page: Page;
let pairingCode = '';

before(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await ctx.newPage();
});

after(async () => {
  await browser?.close();
  sessions.closeAll();
  await daemon.close();
  await relay.close();
  await rm(tmp, { recursive: true, force: true });
});

test('a browser pairs and drives a turn with encryption on', async () => {
  pairingCode = auth.beginPairing().code;

  await page.goto(`${relayBase}/client?room=${ROOM}&key=${KEY}#e=${SECRET}`);
  await page.waitForSelector('#v-pair.on');

  await page.fill('#code', pairingCode);
  await page.click('#pair-go');
  await page.waitForSelector('#v-list.on', { timeout: 20_000 });

  await page.click('#v-list button.btn-primary');
  await page.waitForSelector('#v-session.on', { timeout: 20_000 });

  await page.fill('#input', PROMPT_MARKER);
  await page.click('#send');

  await page.waitForSelector('.approval', { timeout: 25_000 });
  await page.click('.approval button.allow:not(.broad)');
  await page.waitForSelector('.approval.resolved', { timeout: 15_000 });

  const deadline = Date.now() + 5000;
  while (!mocks[0]?.permissionAnswers.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(mocks[0]?.permissionAnswers.at(-1)?.optionId, 'allow-once');
});

test('the secret is stripped from the address bar', async () => {
  // It must not survive into screenshots, shared links, or session restore.
  assert.doesNotMatch(page.url(), /#e=/);
  assert.doesNotMatch(page.url(), new RegExp(SECRET.slice(0, 16)));
});

test('THE RELAY NEVER SEES PLAINTEXT', async () => {
  assert.ok(relayTraffic.length > 5, 'expected traffic to have been captured');
  const all = relayTraffic.join('\n');

  // The prompt the user typed.
  assert.doesNotMatch(all, new RegExp(PROMPT_MARKER), 'prompt text leaked to the relay');
  // The pairing code.
  assert.doesNotMatch(all, new RegExp(pairingCode), 'pairing code leaked to the relay');
  // Agent output from the scripted turn.
  assert.doesNotMatch(all, /Done — created hello\.txt/, 'agent output leaked to the relay');
  // Protocol-level message types that would reveal structure.
  assert.doesNotMatch(all, /"sessionUpdate"/, 'ACP structure leaked to the relay');
  assert.doesNotMatch(all, /allow-edits-session/, 'permission options leaked to the relay');

  // And the frames really are sealed, not merely missing those markers.
  //
  // Three shapes are legitimate:
  //   1. a bare envelope        — WebSocket payloads
  //   2. {method,path,body}     — a tunnelled HTTP request, `body` sealed
  //   3. {status,body}          — the tunnelled HTTP response, `body` sealed
  //
  // Routes and status codes are visible to the relay by necessity: the browser
  // made that HTTP request TO the relay, so it already knows them. That is
  // metadata, not content — and it is the full extent of the exposure.
  const payloads = relayTraffic
    .map((t) => {
      try {
        return JSON.parse(t) as { d?: string };
      } catch {
        return null;
      }
    })
    .filter((f): f is { d: string } => typeof f?.d === 'string');
  assert.ok(payloads.length > 0, 'no payload frames captured');

  for (const f of payloads) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(f.d);
    } catch {
      assert.fail(`unparseable relay payload: ${f.d.slice(0, 120)}`);
    }
    if (isEnvelope(parsed)) continue;

    const wrapper = parsed as { method?: string; path?: string; status?: number; body?: string };
    const isHttpRequest = typeof wrapper.path === 'string' && wrapper.path.startsWith('/api/');
    const isHttpResponse = typeof wrapper.status === 'number';
    assert.ok(isHttpRequest || isHttpResponse, `unsealed non-HTTP frame: ${f.d.slice(0, 160)}`);
    if (wrapper.body) {
      let inner: unknown;
      try {
        inner = JSON.parse(wrapper.body);
      } catch {
        assert.fail(`tunnelled body was not JSON: ${wrapper.body.slice(0, 120)}`);
      }
      assert.ok(
        isEnvelope(inner),
        `tunnelled ${wrapper.path ?? 'response ' + wrapper.status} body was NOT sealed`
      );
    }
  }
});

test('the relay sees route metadata but never request contents', async () => {
  // Being explicit about the boundary: /api/pair is visible as a route, while
  // the code inside it is not. Documented so the guarantee is not overstated.
  const wrappers = relayTraffic
    .map((t) => {
      try {
        return JSON.parse(t) as { d?: string };
      } catch {
        return null;
      }
    })
    .filter((f) => typeof f?.d === 'string')
    .map((f) => {
      try {
        return JSON.parse(f!.d!) as { path?: string; body?: string };
      } catch {
        return null;
      }
    })
    .filter((w): w is { path: string; body?: string } => typeof w?.path === 'string');

  assert.ok(
    wrappers.some((w) => w.path === '/api/pair'),
    'expected the pair route to be visible as metadata'
  );
  for (const w of wrappers) {
    if (w.body) assert.doesNotMatch(w.body, new RegExp(pairingCode));
  }
});

test('the device token never crosses the relay in the clear', async () => {
  const token = await page.evaluate(() => localStorage.getItem('grokrc.token'));
  assert.ok(token, 'browser should hold a token');
  assert.doesNotMatch(relayTraffic.join('\n'), new RegExp(token!), 'device token leaked');
});
