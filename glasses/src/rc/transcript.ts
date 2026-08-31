import type { RcEvent, SessionState } from './protocol'

/**
 * Folds the daemon's event stream into text for the lenses.
 *
 * The canvas holds ten lines, so this is deliberately lossy: tool calls become
 * one line each, thinking is off by default, and only the tail is kept. The
 * full transcript stays on the daemon and in Grok's own log.
 *
 * The `final` flag is load-bearing. The daemon sends streamed chunks with
 * `final:false` and then the coalesced whole with `final:true`. Appending both
 * renders every block twice — see the comment on `RcEvent.thinking` in
 * src/daemon/events.ts. So chunks accumulate into an open block and `final`
 * REPLACES it.
 */

export interface Block {
  kind: 'agent' | 'user' | 'thinking' | 'tool' | 'plan' | 'note'
  text: string
  /** Set for tools so a status update rewrites its line instead of adding one. */
  id?: string
}

/** How many blocks to retain. A phone-sized tail, not a full history. */
const MAX_BLOCKS = 120

const TOOL_MARK: Record<string, string> = {
  pending: '·',
  running: '>',
  ok: 'ok',
  error: '!!',
}

export interface PendingApproval {
  requestId: string
  title: string
  detail?: string
  options: { id: string; label: string; intent: 'allow' | 'deny' | 'other' }[]
}

export class Transcript {
  #blocks: Block[] = []
  #openAgent: Block | null = null
  #openThinking: Block | null = null

  state: SessionState = 'idle'
  approval: PendingApproval | null = null
  showThinking = false

  get blocks(): Block[] {
    return this.#blocks
  }

  clear(): void {
    this.#blocks = []
    this.#openAgent = null
    this.#openThinking = null
    this.approval = null
    this.state = 'idle'
  }

  #push(b: Block): Block {
    this.#blocks.push(b)
    if (this.#blocks.length > MAX_BLOCKS) this.#blocks.splice(0, this.#blocks.length - MAX_BLOCKS)
    return b
  }

  apply(ev: RcEvent): void {
    switch (ev.k) {
      case 'text': {
        if (ev.role === 'user') {
          this.#openAgent = null
          this.#push({ kind: 'user', text: `you: ${ev.text}` })
          return
        }
        if (ev.final) {
          // The coalesced whole. Replace whatever the chunks built.
          if (this.#openAgent) this.#openAgent.text = ev.text
          else this.#push({ kind: 'agent', text: ev.text })
          this.#openAgent = null
          return
        }
        if (this.#openAgent) this.#openAgent.text += ev.text
        else this.#openAgent = this.#push({ kind: 'agent', text: ev.text })
        return
      }

      case 'thinking': {
        if (!this.showThinking) return
        if (ev.final) {
          if (this.#openThinking) this.#openThinking.text = ev.text
          else this.#push({ kind: 'thinking', text: ev.text })
          this.#openThinking = null
          return
        }
        if (this.#openThinking) this.#openThinking.text += ev.text
        else this.#openThinking = this.#push({ kind: 'thinking', text: ev.text })
        return
      }

      case 'tool': {
        // Text is interrupted by a tool call, so the open block ends here.
        this.#openAgent = null
        const mark = TOOL_MARK[ev.status] ?? '·'
        const label = ev.title ?? ev.name
        const line = `[${mark}] ${label}`
        const existing = this.#blocks.find((b) => b.kind === 'tool' && b.id === ev.toolId)
        if (existing) existing.text = line
        else this.#push({ kind: 'tool', text: line, id: ev.toolId })
        return
      }

      case 'plan': {
        this.#openAgent = null
        const done = ev.items.filter((i) => i.status === 'completed').length
        const lines = ev.items.map((i) => `${i.status === 'completed' ? 'x' : '-'} ${i.text}`)
        this.#push({ kind: 'plan', text: `plan ${done}/${ev.items.length}\n${lines.join('\n')}` })
        return
      }

      case 'approval': {
        this.#openAgent = null
        this.approval = {
          requestId: ev.requestId,
          title: ev.title,
          ...(ev.detail ? { detail: ev.detail } : {}),
          options: ev.options.map((o) => ({ id: o.id, label: o.label, intent: o.intent })),
        }
        this.state = 'awaiting-approval'
        return
      }

      case 'approval-resolved': {
        if (this.approval?.requestId === ev.requestId) this.approval = null
        return
      }

      case 'status':
        this.state = ev.state
        if (ev.state !== 'awaiting-approval') this.approval = null
        return

      case 'mode':
        this.#push({ kind: 'note', text: `mode: ${ev.modeId}` })
        return

      case 'error':
        this.#openAgent = null
        this.#push({ kind: 'note', text: `error: ${ev.message}` })
        return

      // 'commands' and 'raw' carry nothing a wearer needs mid-turn.
      default:
        return
    }
  }

  /** The transcript as plain text, oldest first. */
  render(): string {
    if (!this.#blocks.length) return ''
    return this.#blocks.map((b) => b.text).join('\n\n')
  }
}
