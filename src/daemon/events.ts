/**
 * The client-facing event model.
 *
 * ACP is protocolVersion 1 with vendor `x.ai/*` extensions that will drift. This
 * module is the single place that knows ACP's shape; everything downstream —
 * the WebSocket protocol, the PWA — consumes `RcEvent` only. When xAI changes a
 * field name, this file changes and nothing else does.
 *
 * Unknown update kinds are passed through as `raw` rather than dropped, so a new
 * agent release degrades to "we showed you something we didn't understand"
 * instead of silently losing part of the conversation.
 */
import type { RequestPermissionParams, SessionUpdateParams } from '../acp/protocol.ts';

export type SessionState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'awaiting-approval'
  | 'done'
  | 'error';

export type ToolStatus = 'pending' | 'running' | 'ok' | 'error';

export type RcEvent =
  | { k: 'text'; sessionId: string; role: 'agent' | 'user'; text: string; final: boolean }
  /**
   * `final` distinguishes a streamed chunk from the coalesced whole, exactly as
   * it does for `text`. Without it the client cannot tell "append this token"
   * from "here is the finished block", and appends both — rendering the entire
   * reasoning twice.
   */
  | { k: 'thinking'; sessionId: string; text: string; final: boolean }
  | {
      k: 'tool';
      sessionId: string;
      toolId: string;
      name: string;
      status: ToolStatus;
      title?: string;
      input?: unknown;
      output?: unknown;
      locations?: { path: string; line?: number }[];
    }
  | { k: 'plan'; sessionId: string; items: { text: string; status: string }[] }
  | {
      k: 'approval';
      sessionId: string;
      requestId: string;
      title: string;
      detail?: string;
      toolName?: string;
      input?: unknown;
      locations?: { path: string; line?: number }[];
      options: { id: string; label: string; kind: string; intent: 'allow' | 'deny' | 'other' }[];
    }
  | { k: 'approval-resolved'; sessionId: string; requestId: string; optionId: string | null }
  | { k: 'status'; sessionId: string; state: SessionState }
  | { k: 'commands'; sessionId: string; commands: { name: string; description?: string }[] }
  | { k: 'mode'; sessionId: string; modeId: string }
  | { k: 'error'; sessionId?: string; message: string; fatal: boolean }
  | { k: 'raw'; sessionId: string; kind: string; payload: unknown };

/** ACP tool status vocabulary → ours. */
function toolStatus(s: unknown): ToolStatus {
  switch (s) {
    case 'completed':
      return 'ok';
    case 'failed':
      return 'error';
    case 'in_progress':
      return 'running';
    case 'pending':
      return 'pending';
    default:
      return 'running';
  }
}

/**
 * Classify a permission option so the phone can colour buttons correctly and
 * pick a sensible default without hardcoding xAI's option ids.
 *
 * `kind` is checked before `name` because it is the structured field; the name
 * fallback exists only because `kind` is optional in the spec.
 */
export function optionIntent(kind?: string, name?: string): 'allow' | 'deny' | 'other' {
  const k = (kind ?? '').toLowerCase();
  if (k.startsWith('allow')) return 'allow';
  if (k.startsWith('reject') || k.startsWith('deny')) return 'deny';
  const n = (name ?? '').toLowerCase();
  if (/\b(allow|approve|yes|accept|proceed|continue)\b/.test(n)) return 'allow';
  if (/\b(reject|deny|no|cancel|stop|abort)\b/.test(n)) return 'deny';
  return 'other';
}

function textOf(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as { text?: string };
  return typeof c.text === 'string' ? c.text : '';
}

/**
 * Translate one `session/update` notification into zero or more RcEvents.
 *
 * Returns an array because a single ACP update can imply both a content event
 * and a state transition (a tool completing means the session is working again).
 */
export function normalizeSessionUpdate(params: SessionUpdateParams): RcEvent[] {
  const sessionId = params.sessionId;
  const u = params.update ?? ({} as SessionUpdateParams['update']);
  const kind = u.sessionUpdate;

  switch (kind) {
    case 'agent_message_chunk':
      return [{ k: 'text', sessionId, role: 'agent', text: textOf(u.content), final: false }];

    case 'user_message_chunk':
      return [{ k: 'text', sessionId, role: 'user', text: textOf(u.content), final: false }];

    case 'agent_thought_chunk':
      return [{ k: 'thinking', sessionId, text: textOf(u.content), final: false }];

    case 'tool_call':
    case 'tool_call_update': {
      const status = toolStatus(u.status);
      const ev: RcEvent = {
        k: 'tool',
        sessionId,
        toolId: String(u.toolCallId ?? ''),
        name: String(u.kind ?? u.title ?? 'tool'),
        status,
        title: typeof u.title === 'string' ? u.title : undefined,
        input: u.rawInput,
        output: u.rawOutput,
        locations: u.locations,
      };
      return [ev, { k: 'status', sessionId, state: status === 'running' ? 'working' : 'thinking' }];
    }

    case 'plan':
      return [
        {
          k: 'plan',
          sessionId,
          items: (u.entries ?? []).map((e) => ({ text: e.content, status: e.status })),
        },
      ];

    // Observed in real session logs — the agent finished a turn. Without this
    // an observed session would sit on "working" forever.
    case 'turn_completed':
      return [{ k: 'status', sessionId, state: 'done' }];

    case 'available_commands_update':
      return [{ k: 'commands', sessionId, commands: u.availableCommands ?? [] }];

    case 'current_mode_update':
      return [{ k: 'mode', sessionId, modeId: String(u.currentModeId ?? '') }];

    default:
      return [{ k: 'raw', sessionId, kind: String(kind), payload: u }];
  }
}

/** Build the approval event the phone renders as buttons. */
export function normalizePermission(requestId: string, p: RequestPermissionParams): RcEvent {
  const tool = p.toolCall ?? {};
  return {
    k: 'approval',
    sessionId: p.sessionId,
    requestId,
    title: typeof tool.title === 'string' && tool.title ? tool.title : 'Permission required',
    toolName: typeof tool.kind === 'string' ? tool.kind : undefined,
    input: tool.rawInput,
    locations: tool.locations,
    options: (p.options ?? []).map((o) => ({
      id: o.optionId,
      label: o.name ?? o.optionId,
      kind: o.kind ?? '',
      intent: optionIntent(o.kind, o.name),
    })),
  };
}
