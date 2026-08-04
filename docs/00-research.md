# Research — Grok Build remote control

**Date:** 2026-08-04 · **Verified against:** `grok 0.2.118 (1e1687c1cf) [stable]` installed locally.

Everything in §1 was confirmed by running the real binary and capturing live ACP frames
(`docs/captures/acp-handshake.json`), not read from documentation.

---

## 1. What Grok Build actually exposes

xAI shipped **Grok Build** on 2026-05-14 — the official agentic CLI (`xai-org/grok-build`).
It has no remote control. But it exposes an unusually good set of primitives for building one.

### Four agent transports

```
grok agent stdio      JSON-RPC (ACP) over stdin/stdout
grok agent serve      WebSocket SERVER   --bind 127.0.0.1:2419  --secret <TOKEN>
grok agent headless   Dials OUT to a relay --grok-ws-url wss://...
grok agent leader     Shared leader process — multiple clients, ONE backend
```

Two of these are decisive.

**`agent headless --grok-ws-url` — the agent connects outbound.** xAI's own docs describe it
as: *"The agent connects OUT to your relay, and your web clients connect to the same relay.
Useful for building web UIs where browsers can't spawn local processes."* This means a remote
control needs **no inbound port, no port forwarding, and no VPN.**

**`agent leader` + `--leader` — multiple clients share one agent.** The flag reads:
*"Connect to a shared leader process instead of starting a new agent. Allows multiple clients
to share one backend."* Your terminal TUI and your phone can attach to the **same live
session**. That is genuine remote control — not a parallel session, not a mirrored screen.

### ACP capabilities — captured live from `initialize`

```json
{ "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "sessionCapabilities": { "list": {} },
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true },
    "_meta": {
      "x.ai/fs_notify": true,
      "x.ai/hooks": { "blockingEvents": ["pre_tool_use","stop","subagent_stop"],
                      "decisions": ["deny","block"] } } },
  "authMethods": [ { "id": "cached_token", "description": "Cached token from ~/.grok/auth.json" },
                   { "id": "grok.com", "name": "Grok" } ] }
```

`loadSession: true` and `sessionCapabilities.list` mean sessions can be enumerated and
re-opened **through the protocol** — no filesystem scraping required.

### Structured events, not terminal bytes

`--output-format streaming-json` is documented verbatim as *"NDJSON of the agent native ACP
session updates."* Observed notifications during a single `session/new`:

```
session/update → available_commands_update
_x.ai/session_notification → hook_execution, model_changed
_x.ai/models/update · _x.ai/settings/update · _x.ai/mcp/init_progress
```

Permission requests arrive as a typed JSON-RPC **request** — `session/request_permission`,
carrying an `options[]` array of `{optionId, name}` — which the client answers with a
selected `optionId`. **Approval is a protocol message, not text on a screen.**

### Session persistence on disk

```
~/.grok/sessions/<url-encoded-cwd>/<session-id>/
  summary.json      title, model, timestamps
  updates.jsonl     ACP session update stream (conversation + tool calls)  ← authoritative
  plan.json         TODO/task state
```

Plus `~/.grok/active_sessions.json` — a live registry of running sessions with `pid` and `cwd`.
A remote control can therefore **observe a session the user started by hand in their terminal**,
by tailing `updates.jsonl`, without owning or hijacking it.

### Other relevant surface

`--permission-mode` `default | acceptEdits | auto | dontAsk | bypassPermissions | plan` ·
lifecycle hooks (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, shell **and HTTP**
runners) · `--max-turns` · `--tools` / `--allow` / `--deny` · `--sandbox` · MCP · subagents ·
`grok agent serve --secret` (auth is already built in).

---

## 2. The incumbents

| Project | Target CLIs | Transport | Grok Build? | License |
|---|---|---|---|---|
| **MobileCLI** | Claude Code, Codex, Gemini, shell | **PTY** bytes over WebSocket :9847 | ❌ | MIT (daemon) |
| **Happy** | Claude Code, Codex | relay + e2e encryption | ❌ | open source |
| **CloudCLI** (claudecodeui) | Claude Code, OpenCode, Cursor, Codex | web UI over PTY | ❌ | open source |
| **Orca** | AI coding agents, iOS/Android | — | ❌ | open source, 5k★ |
| **superagent-ai/grok-cli** | *its own* community CLI | Telegram long-poll | ❌ (different CLI) | open source |

**Nothing targets xAI's official Grok Build.** The one project with "Grok" in the name is a
community CLI that ships Telegram remote control for *itself* — a different binary, different
protocol, no relationship to `grok agent`.

### The deeper weakness — they all screen-scrape

MobileCLI is the strongest incumbent and its architecture states the problem plainly. It runs a
**"CLI Detection Engine"** that *"fingerprints running processes and parses output to identify
wait states."* It streams raw PTY bytes to a bundled `xterm.js` with *"full ANSI color, cursor
positioning, and alternate screen buffer support."*

That is a terminal emulator on a phone. Consequences:

- **Approvals are guessed.** "Is the agent waiting for me?" is inferred by regex over ANSI
  output. TUI changes break it silently.
- **No semantics.** A diff is characters, not a diff. A tool call is characters. The phone
  cannot render what it cannot identify.
- **Inbound network required.** Their docs warn: *"Keep port 9847 on a trusted LAN, Tailnet,
  firewall allowlist… Do not expose it directly to the public internet."* So you need Tailscale.
- **Typing into a TUI on a touchscreen.**

They screen-scrape because they must: Claude Code and Codex don't expose a structured agent
protocol to third parties. **Grok Build does.** That asymmetry is the entire opportunity.

---

## 3. The thesis

> Existing tools put a terminal on your phone. This one puts the **agent** on your phone.

Concretely, what this project can do that no incumbent can:

| | Incumbents | This |
|---|---|---|
| Transport | PTY bytes | ACP JSON-RPC (typed) |
| Approvals | regex over ANSI | `session/request_permission` → one tap |
| Diffs | characters | rendered diff |
| Networking | inbound port + Tailscale | agent dials **out** — nothing to expose |
| Shared session | new/mirrored session | `agent leader` — laptop and phone on **one** backend |
| Watch a hand-started TUI session | no | yes — tail `updates.jsonl` |
| Platforms | iOS (Android "in development") | PWA — both, day one |
| Grok Build | unsupported | native |

The last row is the market gap. The rest is why it should be better even where they overlap.

---

## 4. Risks

1. **ACP is a moving target.** `protocolVersion: 1`, and the `x.ai/*` `_meta` extensions are
   vendor-specific. Pin the version, capture wire traffic in tests, fail loudly on drift.
2. **`--grok-ws-url` is undocumented in `--help`** (it appears with an empty description).
   The relay wire format must be reverse-engineered and verified before it is depended on.
   Fallback: `agent serve` + our own tunnel.
3. **Auth reuses `~/.grok/auth.json`.** The daemon must never expose or proxy those credentials
   to remote clients.
4. **Remote control of a coding agent is remote code execution by design.** Pairing, transport
   auth, and a default-deny permission posture are load-bearing security, not polish.

---

## Sources

- [xai-org/grok-build](https://github.com/xai-org/grok-build) · [Grok Build overview](https://docs.x.ai/build/overview) · [Headless & scripting](https://docs.x.ai/build/cli/headless-scripting)
- [Agent Client Protocol](https://agentclientprotocol.com)
- [MobileCLI](https://github.com/MobileCLI/mobilecli) · [Happy](https://happy.engineering/) · [CloudCLI / claudecodeui](https://github.com/siteboon/claudecodeui) · [superagent-ai/grok-cli](https://github.com/superagent-ai/grok-cli)
- Local: `grok --help`, `grok agent --help`, `~/.grok/README.md`, `docs/captures/acp-handshake.json`
