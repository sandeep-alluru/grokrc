/**
 * End-to-end encryption between phone and daemon.
 *
 * ONE implementation, imported by both sides — the browser loads it as a module
 * and Node imports this same file. Two hand-written implementations of the same
 * crypto is how you get a bug that only manifests in one direction, so there is
 * deliberately only one.
 *
 * ── How the phone gets the key without the relay seeing it ──────────────────
 *
 * The relay must see `room` and `key` to route, so those live in the query
 * string. The encryption secret lives in the URL **fragment**:
 *
 *     https://relay.example/client?room=R&key=K#e=<secret>
 *                                              ^^^^^^^^^^^
 *     Browsers never transmit the fragment to the server.
 *
 * So the relay routes the connection while being structurally unable to read it.
 *
 * ── What this does and does not protect ─────────────────────────────────────
 *
 * Protects against: a passive relay operator, anyone logging relay traffic, and
 * network observers between phone and relay.
 *
 * Does NOT protect against: a MALICIOUS relay that serves modified JavaScript.
 * The relay serves this very file, so it could serve a version that leaks the
 * key. Encryption cannot fix code delivery. Self-host the relay, or load the
 * client once from the daemon over LAN and let the service worker cache it.
 * Saying otherwise would be the same overclaim this replaced.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

const NONCE_BYTES = 12; // AES-GCM standard
const INFO = 'grokrc/relay/v1';

export function toBase64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** 32 random bytes, base64url. Generated once by the daemon per relay session. */
export function randomSecret() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return toBase64Url(b);
}

/**
 * Derive the AES-256-GCM key from the shared secret.
 *
 * HKDF rather than using the secret bytes directly, so the transported value is
 * never itself the key and the derivation is domain-separated by INFO.
 */
export async function deriveKey(secretB64Url) {
  const material = await subtle.importKey('raw', fromBase64Url(secretB64Url), 'HKDF', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('grokrc'), info: enc.encode(INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt a string. Returns the wire envelope. */
export async function seal(key, plaintext) {
  const nonce = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, enc.encode(plaintext));
  return { n: toBase64Url(nonce), c: toBase64Url(new Uint8Array(ct)) };
}

/**
 * Decrypt an envelope. Throws on tampering — GCM authenticates, so a modified
 * frame fails rather than decrypting to garbage.
 */
export async function open(key, envelope) {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(envelope.n) },
    key,
    fromBase64Url(envelope.c)
  );
  return dec.decode(pt);
}

/** True when a parsed frame looks like our envelope rather than plaintext. */
export function isEnvelope(v) {
  return !!v && typeof v === 'object' && typeof v.n === 'string' && typeof v.c === 'string';
}
