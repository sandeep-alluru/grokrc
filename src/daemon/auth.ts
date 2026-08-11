/**
 * Pairing and device tokens.
 *
 * Remote control of a coding agent is remote code execution by design, so this
 * is load-bearing rather than ceremony:
 *
 *  - Pairing codes are single-use and expire in minutes.
 *  - We persist only a SHA-256 hash of each device token, so a leaked config
 *    file does not yield a working credential.
 *  - Token comparison is constant-time.
 *  - The store is written 0600.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Re-exported: CONFIG_DIR now lives with the code that creates and permissions
// it (config-dir.ts), but many modules import it from here.
export { CONFIG_DIR } from './config-dir.ts';
import { CONFIG_DIR, ensureConfigDir } from './config-dir.ts';
import { background } from './background.ts';
const STORE_PATH = join(CONFIG_DIR, 'devices.json');

const PAIRING_TTL_MS = 5 * 60_000;
/** Unambiguous alphabet — no 0/O, 1/I/L — because these get typed on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
/** Outstanding codes allowed at once — enough for a retry, bounded against abuse. */
const MAX_PENDING_CODES = 8;

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  pairedAt: number;
  lastSeen: number;
}

interface Store {
  devices: Device[];
}

interface PendingPairing {
  code: string;
  expiresAt: number;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class AuthStore {
  #devices: Device[] = [];
  /** code -> expiry. Several can be outstanding at once. */
  #pending = new Map<string, number>();
  #loaded = false;

  async load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const raw = await readFile(STORE_PATH, 'utf8');
      this.#devices = (JSON.parse(raw) as Store).devices ?? [];
    } catch {
      this.#devices = [];
    }
    this.#loaded = true;
  }

  async #save(): Promise<void> {
    await ensureConfigDir(dirname(STORE_PATH));
    await writeFile(STORE_PATH, JSON.stringify({ devices: this.#devices }, null, 2), {
      mode: 0o600,
    });
  }

  get devices(): readonly Device[] {
    return this.#devices;
  }

  /**
   * Start a pairing window.
   *
   * Several codes may be outstanding at once. A single slot looked tidy and was
   * actively harmful: issuing a second code silently killed the first, so the
   * common sequence — hand over a code, be told "invalid", helpfully issue
   * another — destroyed the code being typed and produced the very error it was
   * answering. That loop cost the owner an hour.
   *
   * Each code still expires on its own timer and is still single use.
   */
  beginPairing(): PendingPairing {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.#prunePending();
    // Bounded so a script cannot grow this without limit; oldest goes first.
    while (this.#pending.size >= MAX_PENDING_CODES) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    this.#pending.set(code, expiresAt);
    return { code, expiresAt };
  }

  #prunePending(): void {
    const now = Date.now();
    for (const [code, expiresAt] of this.#pending) {
      if (expiresAt <= now) this.#pending.delete(code);
    }
  }

  get pairingActive(): boolean {
    this.#prunePending();
    return this.#pending.size > 0;
  }

  /**
   * Redeem a pairing code for a device token.
   * The plaintext token is returned exactly once and never stored.
   */
  async redeem(
    code: string,
    deviceName: string
  ): Promise<{ token: string; device: Device } | null> {
    this.#prunePending();
    const given = code.trim().toUpperCase();

    // Compare against every outstanding code, in constant time per candidate,
    // so a match does not depend on which one was issued most recently.
    let matched: string | null = null;
    for (const candidate of this.#pending.keys()) {
      if (constantTimeEqual(given, candidate)) matched = candidate;
    }
    if (!matched) return null;

    this.#pending.delete(matched); // single use, even on a successful redeem
    const token = randomBytes(32).toString('hex');
    const device: Device = {
      id: randomBytes(8).toString('hex'),
      name: deviceName.slice(0, 64) || 'device',
      tokenHash: sha256(token),
      pairedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.#devices.push(device);
    await this.#save();
    return { token, device };
  }

  /** Resolve a bearer token to a device, or null. */
  async verify(token: string): Promise<Device | null> {
    if (!token) return null;
    const hash = sha256(token);
    let device = this.#devices.find((d) => constantTimeEqual(d.tokenHash, hash));

    // A miss may just mean the store changed on disk since we loaded it — the
    // local terminal client mints its own device in another process. Re-read
    // once before rejecting, rather than requiring a daemon restart.
    if (!device) {
      this.#loaded = false;
      await this.load();
      device = this.#devices.find((d) => constantTimeEqual(d.tokenHash, hash));
    }
    if (!device) return null;

    device.lastSeen = Date.now();
    // Not awaited — the caller is authenticating, and a timestamp is not worth
    // blocking on. But `void` alone meant a failed write became an unhandled
    // rejection, and Node kills the process: an antivirus lock on devices.json
    // took down every live session on the next `hello`.
    background('recording when a device was last seen', this.#save());
    return device;
  }

  /**
   * Mint a device token without a pairing code, for a client running locally as
   * the same user.
   *
   * Safe because it requires write access to `~/.grokrc/devices.json` — anyone
   * with that could already forge an entry or read the daemon's memory. Pairing
   * codes exist to authenticate *remote* devices across a network, and add
   * nothing against a local process running as you.
   */
  async mintLocalDevice(name: string): Promise<{ token: string; device: Device }> {
    await this.load();
    const token = randomBytes(32).toString('hex');
    const device: Device = {
      id: randomBytes(8).toString('hex'),
      name: name.slice(0, 64) || 'local',
      tokenHash: sha256(token),
      pairedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.#devices.push(device);
    await this.#save();
    return { token, device };
  }

  async revoke(deviceId: string): Promise<boolean> {
    const before = this.#devices.length;
    this.#devices = this.#devices.filter((d) => d.id !== deviceId);
    if (this.#devices.length === before) return false;
    await this.#save();
    return true;
  }

  async revokeAll(): Promise<void> {
    this.#devices = [];
    await this.#save();
  }
}
