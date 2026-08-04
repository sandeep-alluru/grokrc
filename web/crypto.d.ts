/**
 * Types for the shared browser/Node crypto module.
 *
 * `crypto.js` is authored as plain ESM because the browser loads it directly and
 * there is no build step for `web/`. This declaration lets the daemon import the
 * exact same file with types intact — one implementation, two runtimes.
 */

export interface Envelope {
  /** base64url nonce */
  n: string;
  /** base64url ciphertext */
  c: string;
}

export function toBase64Url(bytes: Uint8Array): string;
export function fromBase64Url(str: string): Uint8Array;
export function randomSecret(): string;
export function deriveKey(secretB64Url: string): Promise<CryptoKey>;
export function seal(key: CryptoKey, plaintext: string): Promise<Envelope>;
export function open(key: CryptoKey, envelope: Envelope): Promise<string>;
export function isEnvelope(v: unknown): v is Envelope;
