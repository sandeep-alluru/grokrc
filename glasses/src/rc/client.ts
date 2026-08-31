import type { ClientMsg, RcEvent, ServerMsg, SessionSummary } from './protocol'
import { storeGet, storeSet, storeDel } from '../lib/store'

/**
 * Talks to the grokrc daemon from the glasses.
 *
 * Everything rides ONE WebSocket — pairing included. The PWA pairs over
 * `POST /api/pair` because the daemon serves it and they share an origin; an
 * installed .ehpk is a foreign origin, so that fetch is blocked and no amount
 * of client-side work fixes it. A WebSocket is not CORS-gated, so this client
 * sends `{t:'pair', code}` on the socket instead and the daemon answers
 * `{t:'paired', token}`. See the `pair` case in src/daemon/server.ts.
 *
 * The daemon URL must be CONFIGURED — an installed build's `location` is the
 * Even Hub host, not grokrc — and must be **wss** (https), because a secure
 * page may not open a plain ws:// socket. That is a browser rule, not a policy
 * choice, and it fails before any request leaves the device.
 */

const URL_KEY = 'grokrc.daemonUrl'
const TOKEN_KEY = 'grokrc.token'

export type ConnState = 'offline' | 'connecting' | 'pairing' | 'ready' | 'unauthorized'

export interface ClientHandlers {
  onState(state: ConnState, detail?: string): void
  onSessions(sessions: SessionSummary[]): void
  onEvent(event: RcEvent): void
  onHistory(sessionId: string, events: RcEvent[]): void
}

/** Reconnect backoff. The phone sleeps constantly; give up slowly, not never. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 20_000]

export class RcClient {
  #base = ''
  #token = ''
  #ws: WebSocket | null = null
  #handlers: ClientHandlers
  #retry = 0
  #closed = false
  /** Resolver for an in-flight pair(), settled by the `paired`/`error` frame. */
  #pairWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null

  constructor(handlers: ClientHandlers) {
    this.#handlers = handlers
  }

  get baseUrl(): string {
    return this.#base
  }
  get paired(): boolean {
    return this.#token.length > 0
  }
  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN
  }

  async load(): Promise<void> {
    this.#base = (await storeGet(URL_KEY)).replace(/\/+$/, '')
    this.#token = await storeGet(TOKEN_KEY)
  }

  async setBaseUrl(url: string): Promise<void> {
    this.#base = url.trim().replace(/\/+$/, '')
    await storeSet(URL_KEY, this.#base)
    this.disconnect()
    this.connect()
  }

  async unpair(): Promise<void> {
    this.#token = ''
    await storeDel(TOKEN_KEY)
    this.disconnect()
  }

  /** Open the socket. Safe with no token — pairing needs the socket first. */
  connect(): void {
    if (!this.#base) return
    this.#closed = false
    this.#open()
  }

  disconnect(): void {
    this.#closed = true
    this.#ws?.close()
    this.#ws = null
  }

  /**
   * Redeem a pairing code over the open socket.
   *
   * Resolves when the daemon returns a token; the caller then reconnects so the
   * socket authenticates through the single `hello` path rather than this one
   * quietly becoming authenticated.
   */
  pair(code: string, deviceName = 'Even Realities G2'): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('not connected to the daemon'))
      if (this.#pairWaiter) return reject(new Error('pairing already in progress'))
      this.#pairWaiter = { resolve, reject }
      this.send({ t: 'pair', code: code.trim().toUpperCase(), deviceName })
      setTimeout(() => {
        if (!this.#pairWaiter) return
        this.#pairWaiter.reject(new Error('the daemon did not answer'))
        this.#pairWaiter = null
      }, 10_000)
    })
  }

  #open(): void {
    // http -> ws, https -> wss. Derived, so the two can never disagree.
    const wsUrl = this.#base.replace(/^http/, 'ws')
    this.#handlers.onState('connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      this.#handlers.onState('offline', e instanceof Error ? e.message : String(e))
      this.#scheduleRetry()
      return
    }
    this.#ws = ws

    ws.addEventListener('open', () => {
      this.#retry = 0
      if (this.#token) this.send({ t: 'hello', token: this.#token })
      else this.#handlers.onState('pairing')
    })

    ws.addEventListener('message', (e) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg
      } catch {
        return // an unparseable frame is not worth tearing the socket down for
      }
      void this.#dispatch(msg)
    })

    ws.addEventListener('close', (e) => {
      this.#ws = null
      if (this.#pairWaiter) {
        this.#pairWaiter.reject(new Error('connection closed during pairing'))
        this.#pairWaiter = null
      }
      // 4401 is the daemon rejecting the token. Retrying cannot fix that, and
      // hammering it would just spin — surface it and stop.
      if (e.code === 4401) {
        this.#handlers.onState('unauthorized')
        return
      }
      this.#handlers.onState('offline')
      this.#scheduleRetry()
    })

    ws.addEventListener('error', () => {
      // 'close' always follows; retry is scheduled there so it happens once.
    })
  }

  #scheduleRetry(): void {
    if (this.#closed) return
    const wait = RETRY_MS[Math.min(this.#retry, RETRY_MS.length - 1)] ?? 20_000
    this.#retry += 1
    setTimeout(() => {
      if (!this.#closed) this.#open()
    }, wait)
  }

  async #dispatch(msg: ServerMsg): Promise<void> {
    switch (msg.t) {
      case 'paired': {
        const token = String((msg as { token?: string }).token ?? '')
        if (!token) return
        this.#token = token
        await storeSet(TOKEN_KEY, token)
        this.#pairWaiter?.resolve()
        this.#pairWaiter = null
        // Authenticate through the one `hello` path rather than treating this
        // socket as implicitly trusted.
        this.send({ t: 'hello', token })
        return
      }
      case 'ready':
        this.#handlers.onState('ready')
        this.send({ t: 'sessions' })
        return
      case 'sessions':
        this.#handlers.onSessions((msg as { sessions?: SessionSummary[] }).sessions ?? [])
        return
      case 'history': {
        const m = msg as { sessionId: string; events?: RcEvent[] }
        this.#handlers.onHistory(m.sessionId, m.events ?? [])
        return
      }
      case 'event': {
        const m = msg as { event?: RcEvent }
        if (m.event) this.#handlers.onEvent(m.event)
        return
      }
      case 'error': {
        const message = String((msg as { message?: string }).message ?? 'error')
        if (this.#pairWaiter) {
          this.#pairWaiter.reject(new Error(message))
          this.#pairWaiter = null
          return
        }
        this.#handlers.onState('offline', message)
        return
      }
      default:
        // Unknown frames are ignored on purpose: a newer daemon must not brick
        // an older pair of glasses.
        return
    }
  }

  send(msg: ClientMsg): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg))
  }

  // Convenience wrappers, so callers never hand-build a frame.
  listSessions(): void {
    this.send({ t: 'sessions' })
  }
  open(sessionId: string): void {
    this.send({ t: 'open', sessionId })
  }
  prompt(sessionId: string, text: string): void {
    this.send({ t: 'prompt', sessionId, text })
  }
  approve(sessionId: string, requestId: string, optionId: string | null): void {
    this.send({ t: 'approve', sessionId, requestId, optionId })
  }
  cancel(sessionId: string): void {
    this.send({ t: 'cancel', sessionId })
  }
}
