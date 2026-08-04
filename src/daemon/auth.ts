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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONFIG_DIR = process.env.GROKRC_HOME ?? join(homedir(), '.grokrc');
const STORE_PATH = join(CONFIG_DIR, 'devices.json');

const PAIRING_TTL_MS = 5 * 60_000;
/** Unambiguous alphabet — no 0/O, 1/I/L — because these get typed on a phone. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

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
  #pending: PendingPairing | null = null;
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
    await mkdir(dirname(STORE_PATH), { recursive: true, mode: 0o700 });
    await writeFile(STORE_PATH, JSON.stringify({ devices: this.#devices }, null, 2), {
      mode: 0o600,
    });
  }

  get devices(): readonly Device[] {
    return this.#devices;
  }

  /** Start a pairing window. Replaces any previous unredeemed code. */
  beginPairing(): { code: string; expiresAt: number } {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    this.#pending = { code, expiresAt: Date.now() + PAIRING_TTL_MS };
    return { ...this.#pending };
  }

  get pairingActive(): boolean {
    return !!this.#pending && this.#pending.expiresAt > Date.now();
  }

  /**
   * Redeem a pairing code for a device token.
   * The plaintext token is returned exactly once and never stored.
   */
  async redeem(
    code: string,
    deviceName: string
  ): Promise<{ token: string; device: Device } | null> {
    if (!this.#pending) return null;
    if (this.#pending.expiresAt <= Date.now()) {
      this.#pending = null;
      return null;
    }
    if (!constantTimeEqual(code.trim().toUpperCase(), this.#pending.code)) return null;

    this.#pending = null; // single use, even on a successful redeem
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
    const device = this.#devices.find((d) => constantTimeEqual(d.tokenHash, hash));
    if (!device) return null;
    device.lastSeen = Date.now();
    void this.#save();
    return device;
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
