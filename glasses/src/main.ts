import { waitForEvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { Display } from './display'
import { RcClient } from './rc/client'
import { Transcript } from './rc/transcript'
import type { RcEvent, SessionSummary } from './rc/protocol'
import { initStore } from './lib/store'
import { mountPhoneUI } from './ui/phone'

const bridge = await waitForEvenAppBridge()

// The SDK's storage is the only kind that survives an app exit in this WebView;
// browser localStorage is wiped, which would demand re-pairing every launch.
initStore(bridge)

const display = new Display(bridge)
const transcript = new Transcript()

/**
 * Views, and the four gestures that drive them.
 *
 * The touchpad reports exactly four things, so every view spends them
 * deliberately. Double-tap is always "back", and backs out of the session list
 * by exiting the app — so the wearer can always leave, from anywhere.
 *
 *   setup     — nothing to drive; use the phone
 *   sessions  — scroll: move cursor · tap: open · 2tap: exit app
 *   session   — scroll: page transcript · tap: jump to newest · 2tap: back
 *   approval  — scroll: choose option · tap: confirm · 2tap: back to session
 */
type View = 'setup' | 'sessions' | 'session' | 'approval'

let view: View = 'setup'
let sessions: SessionSummary[] = []
let cursor = 0
let openId: string | null = null
let optionCursor = 0

const STATE_MARK: Record<string, string> = {
  idle: '·',
  thinking: '~',
  working: '>',
  'awaiting-approval': '?',
  done: 'x',
  error: '!',
}

const client = new RcClient({
  onState(state, detail) {
    if (state === 'unauthorized') {
      view = 'setup'
      display.show('grokrc\n\nPairing was rejected.\nRe-pair from your phone.')
      return
    }
    if (state === 'offline' && view !== 'setup') {
      display.show(`grokrc\n\nDaemon offline.\n${detail ?? 'Reconnecting…'}`)
      return
    }
    if (state === 'ready' && view === 'setup') {
      view = 'sessions'
      renderSessions()
    }
  },

  onSessions(list) {
    sessions = list
    if (view === 'sessions') {
      cursor = Math.min(cursor, Math.max(0, sessions.length - 1))
      renderSessions()
    }
  },

  onHistory(sessionId, events) {
    if (sessionId !== openId) return
    transcript.clear()
    for (const e of events) transcript.apply(e)
    renderSession()
  },

  onEvent(event: RcEvent) {
    // Events for a session we are not watching would corrupt the open one.
    if ('sessionId' in event && event.sessionId && event.sessionId !== openId) return
    transcript.apply(event)
    if (transcript.approval && view === 'session') {
      view = 'approval'
      optionCursor = 0
      renderApproval()
      return
    }
    if (view === 'approval' && !transcript.approval) {
      view = 'session'
      renderSession()
      return
    }
    if (view === 'approval') renderApproval()
    else if (view === 'session') renderSession()
  },
})

function renderSessions(): void {
  if (!sessions.length) {
    display.show('grokrc\n\nNo sessions.\nStart one from your machine or phone.', '2tap: exit')
    return
  }
  const lines = sessions.map((s, i) => {
    const mark = STATE_MARK[s.state ?? 'idle'] ?? '·'
    return `${i === cursor ? '>' : ' '} [${mark}] ${s.title ?? s.id.slice(0, 12)}`
  })
  display.show(lines.join('\n'), 'tap: open · 2tap: exit')
}

function renderSession(): void {
  const body = transcript.render() || '(no output yet)'
  const mark = STATE_MARK[transcript.state] ?? '·'
  display.stream(body, `[${mark}] tap: newest · 2tap: back`)
}

function renderApproval(): void {
  const a = transcript.approval
  if (!a) return
  const opts = a.options.map(
    (o, i) => `${i === optionCursor ? '>' : ' '} ${o.label}${o.intent === 'allow' ? '' : ''}`,
  )
  const detail = a.detail ? `\n${a.detail}` : ''
  display.show(`APPROVE?\n${a.title}${detail}\n\n${opts.join('\n')}`, 'tap: confirm · 2tap: back')
}

const IDLE = 'grokrc\n\nNot set up yet.\nOpen this app on your phone.'
const startResult = await display.start(IDLE, '')
console.log('Page created:', startResult === 0 ? 'success' : `failed (${startResult})`)

await client.load()
// Connect whenever an address is known, with or without a token — pairing now
// happens ON the socket, so it has to be open before a code can be redeemed.
if (client.baseUrl) client.connect()

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? CLICK_EVENT` at the top level would read CLICK
// on events carrying no `sysEvent` at all, so every scroll, exit and audio
// frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Taps and lifecycle arrive on `sysEvent`; scroll gestures on `textEvent`.
// Check DOUBLE_CLICK before CLICK. The R1 ring emits the identical codes, so
// everything here works from the ring with no extra handling.
const unsubscribe = bridge.onEvenHubEvent((event) => {
  const sys = eventTypeOf(event.sysEvent)
  const txt = eventTypeOf(event.textEvent)
  const is = (t: OsEventTypeList) => sys === t || txt === t

  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
    if (view === 'approval') {
      view = 'session'
      renderSession()
    } else if (view === 'session') {
      if (openId) client.send({ t: 'release', sessionId: openId })
      openId = null
      transcript.clear()
      view = 'sessions'
      renderSessions()
    } else {
      bridge.shutDownPageContainer(1)
    }
    return
  }

  if (is(OsEventTypeList.CLICK_EVENT)) {
    if (view === 'sessions') {
      const s = sessions[cursor]
      if (!s) return
      openId = s.id
      transcript.clear()
      client.open(s.id)
      view = 'session'
      renderSession()
    } else if (view === 'session') {
      display.toEnd()
    } else if (view === 'approval') {
      const a = transcript.approval
      const opt = a?.options[optionCursor]
      if (a && opt && openId) {
        client.approve(openId, a.requestId, opt.id)
        transcript.approval = null
        view = 'session'
        renderSession()
      }
    }
    return
  }

  if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
    if (view === 'sessions') {
      cursor = Math.min(cursor + 1, sessions.length - 1)
      renderSessions()
    } else if (view === 'approval') {
      const n = transcript.approval?.options.length ?? 0
      optionCursor = Math.min(optionCursor + 1, Math.max(0, n - 1))
      renderApproval()
    } else {
      display.nextPage()
    }
    return
  }

  if (is(OsEventTypeList.SCROLL_TOP_EVENT)) {
    if (view === 'sessions') {
      cursor = Math.max(cursor - 1, 0)
      renderSessions()
    } else if (view === 'approval') {
      optionCursor = Math.max(optionCursor - 1, 0)
      renderApproval()
    } else {
      display.prevPage()
    }
    return
  }

  // Returning to the foreground can leave the lenses on a stale frame.
  if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    display.redraw()
    return
  }

  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    client.disconnect()
    unsubscribe()
  }
})

mountPhoneUI(document.getElementById('app')!, client, {
  onPrompt(text) {
    if (openId) client.prompt(openId, text)
  },
  onRefresh() {
    client.listSessions()
  },
  status: () => transcript.state,
})
