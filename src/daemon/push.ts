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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import { CONFIG_DIR } from './auth.ts';
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

export class PushService {
  #keys: VapidKeys | null = null;
  #subs: StoredSubscription[] = [];
  #loaded = false;

  /** Generate VAPID keys on first run and reuse them thereafter. */
  async load(): Promise<void> {
    if (this.#loaded) return;
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

    try {
      this.#keys = JSON.parse(await readFile(KEYS_PATH, 'utf8')) as VapidKeys;
    } catch {
      const generated = webpush.generateVAPIDKeys();
      // `mailto:` is required by the spec; it is never contacted for a
      // self-hosted daemon, so a placeholder is honest rather than a real address.
      this.#keys = { ...generated, subject: 'mailto:grokrc@localhost' };
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
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
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
        } catch (err) {
          // 404/410 mean the browser dropped the subscription for good — prune
          // it, or the list grows forever and every send retries dead endpoints.
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) dead.push(s.subscription.endpoint);
        }
      })
    );

    if (dead.length) {
      this.#subs = this.#subs.filter((s) => !dead.includes(s.subscription.endpoint));
      await this.#save();
    }
  }
}
