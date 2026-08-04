# Architecture — `grokrc`

> Existing tools put a terminal on your phone. This puts the **agent** on your phone.

---

## 1. Topology

```
   ┌──────────────┐                                    ┌─────────────────┐
   │  Phone PWA   │                                    │  grokrc daemon  │
   │              │                                    │  (dev machine)  │
   └──────┬───────┘                                    └────────┬────────┘
          │                                                     │ ACP JSON-RPC
          │   ── DIRECT MODE ──  ws:// LAN or Tailscale ────────┤ (stdin/stdout)
          │                                                     │
          │                    ┌────────────┐                   │
          └── RELAY MODE ─wss─►│   relay    │◄─wss─ dials OUT ──┤
                               └────────────┘                   │
                                                       ┌────────▼────────┐
                                                       │  grok agent     │
                                                       │  stdio / leader │
                                                       └─────────────────┘
```

**Direct mode** — PWA talks to the daemon over the LAN or a Tailnet. No extra infrastructure.

**Relay mode** — the daemon dials **outbound** to a relay; the phone connects to the same
relay. Nothing is listening on the dev machine. This is the mode incumbents can't offer,
because their agents can't initiate an outbound connection — Grok Build's
`agent headless --grok-ws-url` can.

The relay is a dumb forwarder — it never parses ACP and holds no session state.

> ⚠️ **It does, however, see plaintext.** End-to-end encryption between phone and daemon
> is designed but **not implemented**. Until it is, treat the relay host as trusted:
> run it yourself, on infrastructure you control. Do not use someone else's relay.

---

## 2. Why ACP, not PTY

Every incumbent streams pseudo-terminal bytes and regexes the ANSI output to guess when the
agent is waiting for approval. We speak the agent's own protocol instead:

| Need | PTY approach | ACP approach |
|---|---|---|
| "Is it waiting on me?" | regex over ANSI; breaks on TUI changes | `session/request_permission` — a typed JSON-RPC request |
| Approve a tool call | send keystrokes and hope | reply with the chosen `optionId` |
| Render a diff | characters in a tiny xterm | structured content → real diff view |
| Know the model/plan/tools | scrape | `session/update` typed events |

**Consequence:** the phone client is a real UI over typed data, not a terminal emulator.

---

## 3. Session modes

Three ways a session can exist. All three appear in one list on the phone.

| Mode | How | Control | Use |
|---|---|---|---|
| **Owned** | daemon spawns `grok agent stdio` | full | started from the phone |
| **Shared** | `grok agent leader` + `--leader` | full, **concurrent with the TUI** | laptop ↔ phone handoff mid-task |
| **Observed** | tail `~/.grok/sessions/<cwd>/<id>/updates.jsonl` | read-only | watch a session started by hand in a terminal |

Observed mode matters more than it looks: it means installing `grokrc` doesn't change how you
work. Your terminal sessions become visible on your phone without being started through us.

---

## 4. The event model — the load-bearing abstraction

ACP is `protocolVersion: 1` with vendor `x.ai/*` extensions that **will** drift. The daemon
normalizes everything into a stable union the client renders. When ACP changes, one translation
layer changes; the client does not.

```ts
type RcEvent =
  | { k: 'text';      sessionId, role: 'agent'|'user', text, final }
  | { k: 'thinking';  sessionId, text }
  | { k: 'tool';      sessionId, toolId, name, status: 'pending'|'running'|'ok'|'error',
                      title?, input?, output?, diff?: { path, before, after } }
  | { k: 'plan';      sessionId, items: { text, status }[] }
  | { k: 'approval';  sessionId, requestId, title, detail?, options: { id, label, kind }[] }
  | { k: 'status';    sessionId, state: 'idle'|'thinking'|'working'|'awaiting-approval'|'done' }
  | { k: 'session';   sessionId, cwd, title, model, mode }
  | { k: 'error';     sessionId?, message, fatal }
```

`approval` is the centrepiece. It arrives as a first-class object with real options, so the
phone renders actual buttons and answers by `optionId`. No guessing.

---

## 5. Security

Remote control of a coding agent **is** remote code execution. Treated as load-bearing, not polish.

1. **Pairing** — QR or 6-digit code, short TTL, one-time. Device gets a long-lived token; the
   daemon stores only a hash.
2. **Transport auth** — every frame authenticated. `agent serve` already supports `--secret`.
3. **Relay is NOT yet zero-knowledge.** The intent is e2e encryption between phone and
   daemon so the relay routes ciphertext only. **This is not built.** Today the relay can
   read every frame, including prompts and agent output. Self-host it, and don't rely on
   it for confidentiality until this lands.
4. **Credentials never leave the machine** — `~/.grok/auth.json` is used by the local agent
   only. The daemon never proxies or exposes it.
5. **Default-deny permissions** — the daemon never launches with `--always-approve` or
   `bypassPermissions` unless explicitly configured. Remote approval is a human tapping a
   button, not a policy that auto-approves because a phone is attached.
6. **Bind to loopback by default.** Exposure is opt-in and loud.

---

## 6. Layout

```
grokrc/
  src/
    acp/         ACP JSON-RPC client, transports, protocol types
    daemon/      session manager, event normalizer, WS server, pairing, config
    cli.ts       grokrc up | pair | status | sessions
  web/           mobile-first PWA (no framework, no build step)
  relay/         optional self-hostable forwarder
  tools/         acp-probe.mjs — captures real wire traffic
  docs/captures/ recorded ACP frames used as test fixtures
```

**PWA, not native.** iOS and Android both work day one, no app store review, no separate
codebases. MobileCLI is iOS-only with Android "in development" — that gap is free to take.

---

## 7. Build order

1. **ACP client** over stdio — handshake, session lifecycle, request/notification routing ✅
2. **Event normalizer** — ACP → `RcEvent`, with recorded frames as fixtures
3. **Session manager** — owned / shared / observed
4. **WS server + pairing**
5. **PWA** — session list, stream, one-tap approvals
6. **Relay** — outbound mode
7. **Push notifications** on approval requests (Web Push; no third-party cloud)
