/**
 * The grokrc daemon wire protocol, as the glasses speak it.
 *
 * These types MIRROR the daemon's own declarations and must stay in step with
 * them. The authoritative copies live in:
 *
 *   ClientMsg          src/daemon/server.ts
 *   RcEvent, states    src/daemon/events.ts
 *
 * They are restated rather than imported because the daemon is Node-targeted
 * (NodeNext, `.ts` specifiers, server-only imports) and this is a browser
 * bundle; importing across that boundary drags the whole daemon graph into a
 * WebView. The trade is a copy that can drift, so the copy is kept small,
 * type-only, and pointed at its source.
 */

export type SessionState = 'idle' | 'thinking' | 'working' | 'awaiting-approval' | 'done' | 'error'
export type ToolStatus = 'pending' | 'running' | 'ok' | 'error'

export interface ApprovalOption {
  id: string
  label: string
  kind: string
  intent: 'allow' | 'deny' | 'other'
}

/** Daemon -> glasses. Mirrors `RcEvent` in src/daemon/events.ts. */
export type RcEvent =
  | { k: 'text'; sessionId: string; role: 'agent' | 'user'; text: string; final: boolean }
  | { k: 'thinking'; sessionId: string; text: string; final: boolean }
  | {
      k: 'tool'
      sessionId: string
      toolId: string
      name: string
      status: ToolStatus
      title?: string
      input?: unknown
      output?: unknown
      locations?: { path: string; line?: number }[]
    }
  | { k: 'plan'; sessionId: string; items: { text: string; status: string }[] }
  | {
      k: 'approval'
      sessionId: string
      requestId: string
      title: string
      detail?: string
      toolName?: string
      input?: unknown
      locations?: { path: string; line?: number }[]
      options: ApprovalOption[]
    }
  | { k: 'approval-resolved'; sessionId: string; requestId: string; optionId: string | null }
  | { k: 'status'; sessionId: string; state: SessionState }
  | { k: 'commands'; sessionId: string; commands: { name: string; description?: string }[] }
  | { k: 'mode'; sessionId: string; modeId: string }
  | { k: 'error'; sessionId?: string; message: string; fatal: boolean }
  | { k: 'raw'; sessionId: string; kind: string; payload: unknown }

/** Glasses -> daemon. Mirrors `ClientMsg` in src/daemon/server.ts. */
export type ClientMsg =
  | { t: 'hello'; token: string; assetVersion?: string }
  /** Pair over the socket — the daemon's HTTP API is unreachable cross-origin. */
  | { t: 'pair'; code: string; deviceName?: string }
  | { t: 'sessions' }
  | { t: 'open'; sessionId: string; cwd?: string }
  | { t: 'resume'; sessionId: string; cwd: string }
  | { t: 'takeover'; sessionId: string; cwd: string }
  | { t: 'release'; sessionId: string }
  | { t: 'trace'; step: string; detail?: string }
  | { t: 'create'; cwd?: string; model?: string; title?: string }
  | { t: 'prompt'; sessionId: string; text: string }
  | { t: 'approve'; sessionId: string; requestId: string; optionId: string | null }
  | { t: 'cancel'; sessionId: string }
  | { t: 'close'; sessionId: string }

export interface SessionSummary {
  id: string
  title?: string
  cwd?: string
  state?: SessionState
  model?: string
  mode?: string
  updatedAt?: number
}

/**
 * Daemon -> glasses envelopes.
 *
 * Only the frames the glasses act on are named; anything else is tolerated so a
 * newer daemon does not break an older pair of glasses.
 */
export type ServerMsg =
  | { t: 'ready'; leaderMode?: boolean; assetVersion?: string }
  | { t: 'paired'; token: string; device?: { id: string; name: string } }
  | { t: 'sessions'; sessions: SessionSummary[] }
  | { t: 'created'; sessionId: string }
  | { t: 'resumed'; sessionId: string }
  | { t: 'released'; sessionId: string }
  | { t: 'history'; sessionId: string; events: RcEvent[] }
  | { t: 'event'; event: RcEvent }
  | { t: 'error'; message: string }
  | { t: 'down'; reason?: string }
  | { t: string; [k: string]: unknown }
