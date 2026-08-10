/**
 * A relay can be pure transport — moving frames it cannot read, serving no code.
 *
 * BACKLOG #16. Relay mode encrypts payloads with a key that lives in the URL
 * fragment, which browsers never send, so the relay routes what it cannot read.
 * That is worth having and it is not enough: the relay also served the PWA, and
 * the page's JavaScript is what decrypts. An operator who ships modified code
 * reads everything before encryption is ever applied.
 *
 * No integrity check inside the page can fix that. Code supplied by the attacker
 * cannot verify itself, and since the relay serves index.html too it can simply
 * remove an SRI attribute. The only sound answer is to get the client from
 * somewhere else — so a relay must be able to refuse to be that somewhere.
 *
 * The load-bearing half of this test is the LAST one: refusing to serve the
 * client must not break the transport, or nobody will turn it on.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';

const { RelayServer } = await import('../src/relay/server.ts');
const { WebSocket } = await import('ws');

const openRelay = new RelayServer(); // default: serves the client
const shutRelay = new RelayServer({ serveClient: false });
const openPort = await openRelay.listen(0, '127.0.0.1');
const shutPort = await shutRelay.listen(0, '127.0.0.1');

after(async () => {
  await openRelay.close();
  await shutRelay.close();
});

test('by default a relay serves the client — the behaviour being opted out of', async () => {
  const res = await fetch(`http://127.0.0.1:${openPort}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /grokrc/);
});

test('a transport-only relay hands out no JavaScript at all', async () => {
  for (const path of ['/', '/client', '/app.js', '/index.html', '/sw.js']) {
    const res = await fetch(`http://127.0.0.1:${shutPort}${path}`);
    assert.equal(res.status, 404, `${path} must not be served by a transport-only relay`);
    const body = await res.text();
    assert.ok(
      !body.includes('function') && !body.includes('<!doctype'),
      `${path} returned something that looks like code or markup`
    );
  }
});

test('the refusal says why and names the fix', async () => {
  // A bare 404 reads as a broken relay and sends the user after the wrong
  // problem entirely.
  const body = (await (await fetch(`http://127.0.0.1:${shutPort}/`)).json()) as {
    error: string;
    install?: string;
  };
  assert.match(body.error, /transport-only/i);
  assert.match(String(body.install), /install the app from/i);
});

test('refusing the client does NOT break the transport', async () => {
  // If turning this on cost you the relay, nobody would turn it on. /health and
  // the agent socket must both still work.
  const health = await fetch(`http://127.0.0.1:${shutPort}/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { ok: boolean }).ok, true);

  const ws = new WebSocket(`ws://127.0.0.1:${shutPort}/agent?room=r1&key=k1`);
  const opened = await new Promise<boolean>((res) => {
    ws.once('open', () => res(true));
    ws.once('error', () => res(false));
  });
  assert.equal(opened, true, 'a daemon must still be able to attach to a transport-only relay');
  ws.close();
});
