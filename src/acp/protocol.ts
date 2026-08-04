/**
 * ACP (Agent Client Protocol) wire types as implemented by Grok Build.
 *
 * Verified against `grok 0.2.118` — see docs/captures/acp-handshake.json for the
 * recorded `initialize` response these types were derived from.
 *
 * Deliberately permissive: xAI ships vendor extensions under `_meta` and
 * `_x.ai/*` notification methods that are not part of the base spec and will
 * change. We type what we depend on and pass the rest through untouched rather
 * than pretending to model a moving target.
 */

export const ACP_PROTOCOL_VERSION = 1;

/* ─── JSON-RPC envelope ─────────────────────────────────────────────────── */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return 'id' in m && m.id !== undefined && !('method' in m);
}

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return 'id' in m && m.id !== undefined && 'method' in m;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return !('id' in m) && 'method' in m;
}

/* ─── initialize ────────────────────────────────────────────────────────── */

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    sessionCapabilities?: { list?: unknown };
    auth?: unknown;
    _meta?: Record<string, unknown>;
  };
  authMethods?: { id: string; name?: string; description?: string }[];
  _meta?: Record<string, unknown>;
}

/* ─── session/update notifications ──────────────────────────────────────── */

/**
 * Discriminator values observed on `params.update.sessionUpdate`.
 * `available_commands_update` is confirmed from a live capture; the rest follow
 * the ACP spec's naming and are handled defensively — an unknown value is
 * surfaced as a passthrough event rather than dropped.
 */
export type SessionUpdateKind =
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'user_message_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update'
  | (string & {});

export interface ContentBlock {
  type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link' | (string & {});
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  [k: string]: unknown;
}

export interface SessionUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate: SessionUpdateKind;
    content?: ContentBlock;
    /** tool_call / tool_call_update */
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed' | (string & {});
    rawInput?: unknown;
    rawOutput?: unknown;
    content_?: unknown;
    locations?: { path: string; line?: number }[];
    /** plan */
    entries?: { content: string; status: string; priority?: string }[];
    /** available_commands_update */
    availableCommands?: { name: string; description?: string }[];
    /** current_mode_update */
    currentModeId?: string;
    [k: string]: unknown;
  };
}

/* ─── session/request_permission (agent → client request) ───────────────── */

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | (string & {});
}

export interface RequestPermissionParams {
  sessionId: string;
  options: PermissionOption[];
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    locations?: { path: string; line?: number }[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

/* ─── session lifecycle ─────────────────────────────────────────────────── */

export interface NewSessionResult {
  sessionId: string;
  modes?: { currentModeId?: string; availableModes?: { id: string; name?: string }[] };
  [k: string]: unknown;
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | (string & {});

export interface PromptResult {
  stopReason: StopReason;
  [k: string]: unknown;
}
