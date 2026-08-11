/**
 * Web Push — the piece that makes remote control actually useful.
 *
 * Without it, an approval request only reaches you if the app happens to be open
 * and the socket alive. In practice the phone is locked in your pocket and the
 * agent sits blocked. A push notification is what turns "I can approve from my
 * phone" into "my phone told me it needed approving".
 *
 * Self-hosted VAPID. Notifications go from your machine to the browser vendor's
 * push service and nowhere else — no third-party cloud in the path. (MobileCLI
 * routes its push through Expo's servers.) The payload is encrypted per RFC 8291
 * by `web-push`; the push service sees ciphertext.
 *
 * Payloads deliberately carry no code, no diffs, and no tool arguments — only
 * enough to get you to the right screen. Notifications surface on a lock screen.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import { CONFIG_DIR } from './auth.ts';
import { ensureConfigDir } from './config-dir.ts';
import type { RcEvent } from './events.ts';

const KEYS_PATH = join(CONFIG_DIR, 'vapid.json');
const SUBS_PATH = join(CONFIG_DIR, 'push-subscriptions.json');

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface StoredSubscription {
  deviceId: string;
  subscription: webpush.PushSubscription;
  createdAt: number;
}

export interface PushStats {
  sent: number;
  /** Subscription gone for good (404/410) — expected, pruned. */
  expired: number;
  /** Something is wrong — bad keys, rejecting service, network. NOT pruned. */
  failed: number;
}

export interface PushError {
  message: string;
  at: number;
  endpoint: string;
}

/**
 * VAPID `sub` — who to contact about this pusher.
 *
 * Apple rejects a subject it cannot route, with a 403 and no explanation. A
 * project URL is valid per RFC 8292, needs no personal email, and is the same
 * for every self-hosted install. Override with GROKRC_VAPID_SUBJECT.
 */
const VAPID_SUBJECT =
  process.env.GROKRC_VAPID_SUBJECT || 'https://github.com/sandeep-alluru/grokrc';

/** A subject Apple will accept: https:// URL, or mailto: with a real domain. */
export function isRoutableSubject(subject: string): boolean {
  if (typeof subject !== 'string') return false;
  if (subject.startsWith('https://')) {
    try {
      const h = new URL(subject).hostname;
      return h.includes('.') && h !== 'localhost';
    } catch {
      return false;
    }
  }
  if (!subject.startsWith('mailto:')) return false;
  const domain = subject.slice(7).split('@')[1] ?? '';
  return domain.includes('.') && !domain.endsWith('.localhost') && domain !== 'localhost';
}

export class PushService {
  #keys: VapidKeys | null = null;
  #subs: StoredSubscription[] = [];
  #loaded = false;
  #stats: PushStats = { sent: 0, expired: 0, failed: 0 };
  #lastError: PushError | null = null;

  /** Generate VAPID keys on first run and reuse them thereafter. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    await ensureConfigDir();

    try {
      this.#keys = JSON.parse(await readFile(KEYS_PATH, 'utf8')) as VapidKeys;
    } catch {
      const generated = webpush.generateVAPIDKeys();
      this.#keys = { ...generated, subject: VAPID_SUBJECT };
      await writeFile(KEYS_PATH, JSON.stringify(this.#keys, null, 2), { mode: 0o600 });
    }

    // Repair keys written before the subject was known to matter. Apple
    // validates the JWT `sub` claim and rejects a non-routable address with a
    // bare 403; Mozilla does not check, so this failed on iPhones only while
    // desktop Firefox kept working. The subject is part of the signed token,
    // NOT the key pair, so rewriting it does not invalidate any subscription.
    if (!isRoutableSubject(this.#keys.subject)) {
      this.#keys = { ...this.#keys, subject: VAPID_SUBJECT };
      await writeFile(KEYS_PATH, JSON.stringify(this.#keys, null, 2), { mode: 0o600 });
    }

    try {
      this.#subs = JSON.parse(await readFile(SUBS_PATH, 'utf8')) as StoredSubscription[];
    } catch {
      this.#subs = [];
    }

    webpush.setVapidDetails(this.#keys.subject, this.#keys.publicKey, this.#keys.privateKey);
    this.#loaded = true;
  }

  get publicKey(): string {
    return this.#keys?.publicKey ?? '';
  }

  get subscriberCount(): number {
    return this.#subs.length;
  }

  /**
   * Delivery counters, so "push isn't working" is answerable.
   * `expired` (browser dropped the subscription) is tracked apart from `failed`
   * (something is wrong) — they need different responses.
   */
  get stats(): Readonly<PushStats> {
    return { ...this.#stats };
  }

  /** The most recent delivery fault, or null. Surfaced by `grokrc doctor`. */
  get lastError(): Readonly<PushError> | null {
    return this.#lastError ? { ...this.#lastError } : null;
  }

  async subscribe(deviceId: string, subscription: webpush.PushSubscription): Promise<void> {
    // One subscription per endpoint — re-subscribing must replace, not duplicate,
    // or every reinstall doubles the notifications.
    this.#subs = this.#subs.filter((s) => s.subscription.endpoint !== subscription.endpoint);
    this.#subs.push({ deviceId, subscription, createdAt: Date.now() });
    await this.#save();
  }

  async unsubscribeDevice(deviceId: string): Promise<void> {
    this.#subs = this.#subs.filter((s) => s.deviceId !== deviceId);
    await this.#save();
  }

  async #save(): Promise<void> {
    await ensureConfigDir();
    await writeFile(SUBS_PATH, JSON.stringify(this.#subs, null, 2), { mode: 0o600 });
  }

  /**
   * Push an approval request. Called for every approval regardless of whether a
   * socket is connected — a connected socket does not mean a watching human.
   */
  async notifyApproval(
    ev: Extract<RcEvent, { k: 'approval' }>,
    sessionTitle: string
  ): Promise<void> {
    await this.#send({
      title: 'Grok needs approval',
      body: `${sessionTitle}: ${ev.title}`.slice(0, 160),
      tag: `approval-${ev.requestId}`,
      sessionId: ev.sessionId,
      requestId: ev.requestId,
      requireInteraction: true,
    });
  }

  /** Turn finished while you were away. */
  async notifyDone(sessionId: string, sessionTitle: string): Promise<void> {
    await this.#send({
      title: 'Grok finished',
      body: sessionTitle.slice(0, 160),
      tag: `done-${sessionId}`,
      sessionId,
      requireInteraction: false,
    });
  }

  async #send(payload: Record<string, unknown>): Promise<void> {
    if (!this.#loaded || this.#subs.length === 0) return;
    const body = JSON.stringify(payload);
    const dead: string[] = [];

    await Promise.all(
      this.#subs.map(async (s) => {
        try {
          await webpush.sendNotification(s.subscription, body);
          this.#stats.sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;

          // 404/410 mean the browser dropped the subscription for good — prune,
          // or the list grows forever and every send retries dead endpoints.
          if (status === 404 || status === 410) {
            dead.push(s.subscription.endpoint);
            this.#stats.expired++;
            return;
          }

          // ANYTHING ELSE is a fault, not an expiry: bad VAPID keys, a rejecting
          // push service, a network outage. These used to be swallowed entirely,
          // so a completely broken push setup looked identical to an idle one.
          // Deliberately NOT pruned — unsubscribing someone's phone because of a
          // transient outage is worse than retrying a live endpoint.
          this.#stats.failed++;
          this.#lastError = {
            message: `push failed (${status ?? 'no status'}): ${(err as Error).message}`.slice(
              0,
              300
            ),
            at: Date.now(),
            endpoint: new URL(s.subscription.endpoint).host,
          };
          console.warn(`  push: ${this.#lastError.message}`);
        }
      })
    );

    if (dead.length) {
      this.#subs = this.#subs.filter((s) => !dead.includes(s.subscription.endpoint));
      await this.#save();
    }
  }
}
