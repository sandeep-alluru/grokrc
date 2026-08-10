/**
 * A request body must survive being split mid-character.
 *
 * Found by a strict type-aware sweep: `raw += chunk` where `chunk` is a Buffer.
 * That decodes EACH CHUNK INDEPENDENTLY. A multi-byte UTF-8 character whose
 * bytes land either side of a chunk boundary is decoded as two invalid
 * fragments and comes out as U+FFFD replacement characters — the text is
 * silently corrupted, not rejected.
 *
 * TCP decides where the boundary falls, so this is not exotic: it depends on
 * packet timing, not on anything the caller does wrong. The bigger the body, the
 * likelier it is. `deviceName` is the reachable path — name a phone
 * "Sandeep’s iPhone" with a curly apostrophe, or anything non-ASCII, and the
 * stored name can be mangled.
 *
 * Real HTTP over a real socket: the split is forced by writing the bytes in two
 * pieces, which is exactly what the network does on its own.
 */
import { strict as assert } from 'node:assert';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';

const tmp = await mkdtemp(join(tmpdir(), 'grokrc-bodyenc-'));
process.env.GROKRC_HOME = tmp;

const { AuthStore } = await import('../src/daemon/auth.ts');
const { SessionManager } = await import('../src/daemon/session-manager.ts');
const { RemoteControlServer } = await import('../src/daemon/server.ts');

const auth = new AuthStore();
await auth.load();
const sessions = new SessionManager();
const server = new RemoteControlServer({
  host: '127.0.0.1',
  port: 0,
  webRoot: resolve(import.meta.dirname, '../web'),
  sessions,
  auth,
});
const { port } = await server.listen();

after(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

/**
 * POST `body` with the raw bytes deliberately split at `splitAt`, so the two
 * halves arrive as separate chunks. Returns the parsed JSON response.
 */
function postSplit(path: string, body: string, splitAt: number): Promise<unknown> {
  const buf = Buffer.from(body, 'utf8');
  const head = Buffer.from(
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${buf.length}\r\nConnection: close\r\n\r\n`,
    'utf8'
  );

  return new Promise((res, rej) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(head);
      sock.write(buf.subarray(0, splitAt));
      // A real network split is a separate TCP segment arriving later. The delay
      // stops Node coalescing the two writes into one chunk, which would make
      // this test quietly prove nothing.
      setTimeout(() => sock.write(buf.subarray(splitAt)), 40);
    });
    let out = '';
    sock.on('data', (d) => (out += d.toString('utf8')));
    sock.on('error', rej);
    sock.on('close', () => {
      // The response comes back Transfer-Encoding: chunked, so the body carries
      // chunk-size prefixes and slicing past the headers is not enough. Pull the
      // JSON object out by its braces — the payload is a single flat object.
      const i = out.indexOf('{');
      const j = out.lastIndexOf('}');
      try {
        res(JSON.parse(out.slice(i, j + 1)));
      } catch (err) {
        rej(new Error(`could not parse response: ${out.slice(0, 300)} (${String(err)})`));
      }
    });
  });
}

test('a device name survives a chunk boundary inside a multi-byte character', async () => {
  const { code } = auth.beginPairing();
  // U+2019 (’) is three bytes: E2 80 99. Padding pushes it well past the header
  // so the split lands inside the character itself.
  const name = 'Sandeep’s iPhone';
  const body = JSON.stringify({ code, deviceName: name });

  const bytes = Buffer.from(body, 'utf8');
  const marker = Buffer.from('’', 'utf8');
  const at = bytes.indexOf(marker);
  assert.ok(at > 0, 'test setup: the multi-byte character must be in the body');

  // Split INSIDE the three-byte sequence.
  const result = (await postSplit('/api/pair', body, at + 1)) as { token?: string };
  assert.ok(result.token, `pairing should succeed; got ${JSON.stringify(result)}`);

  const stored = auth.devices.at(-1);
  assert.equal(
    stored?.name,
    name,
    `the stored name was corrupted by the chunk split: ${JSON.stringify(stored?.name)}`
  );
});

test('a plain ASCII body still works when split', async () => {
  // The control: if splitting broke everything, the test above would pass for
  // the wrong reason once "fixed".
  const { code } = auth.beginPairing();
  const body = JSON.stringify({ code, deviceName: 'plain-ascii-phone' });
  const result = (await postSplit('/api/pair', body, 12)) as { token?: string };
  assert.ok(result.token, `pairing should succeed; got ${JSON.stringify(result)}`);
  assert.equal(auth.devices.at(-1)?.name, 'plain-ascii-phone');
});
