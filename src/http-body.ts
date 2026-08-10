/**
 * Read an HTTP request body as text — once, correctly.
 *
 * There were three copies of this, all written the same wrong way:
 *
 *     let raw = '';
 *     for await (const chunk of req) raw += chunk;
 *
 * `chunk` is a Buffer, so `raw += chunk` calls `Buffer.toString()` on EACH CHUNK
 * INDEPENDENTLY. A multi-byte UTF-8 character whose bytes straddle a chunk
 * boundary is decoded as two invalid fragments and silently becomes U+FFFD
 * replacement characters. TCP chooses where that boundary falls, so it depends
 * on packet timing rather than on anything the caller did wrong.
 *
 * Reproduced against the real pairing endpoint: pairing a device named
 * "Sandeep’s iPhone" with the split inside the apostrophe's three bytes stored
 * `"Sandeep���s iPhone"`. See test/body-encoding.test.ts.
 *
 * The fix is to accumulate BYTES and decode once at the end. The limit is now
 * counted in bytes too, which is what a byte limit should always have meant —
 * the old character count let a body of multi-byte characters exceed the
 * intended size.
 */
import type { IncomingMessage } from 'node:http';

/**
 * Returns the decoded body, or `null` if it exceeded `limit` bytes — in which
 * case the request has already been destroyed and the caller should answer 413.
 */
export async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += buf.length;
    if (size > limit) {
      req.destroy();
      return null;
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks).toString('utf8');
}
