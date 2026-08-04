# grokrc

**Remote control for xAI's Grok Build CLI.** Drive your terminal coding agent from your
phone — over the agent's own protocol, not a screen scrape.

> Existing tools put a terminal on your phone. This puts the **agent** on your phone.

---

## Why this exists

xAI shipped [Grok Build](https://github.com/xai-org/grok-build) in May 2026. It has no
remote control, and **no open-source project targets it** — every existing mobile client
(MobileCLI, Happy, CloudCLI, Orca) supports Claude Code and Codex only.

More importantly, they all work the same way: stream raw PTY bytes to a phone-sized
`xterm.js` and run a regex over the ANSI output to guess whether the agent is waiting for
you. MobileCLI literally documents a *"CLI Detection Engine"* that *"parses output to
identify wait states."*

They screen-scrape because they must — Claude Code and Codex don't expose a structured
agent protocol. **Grok Build does.** It speaks
[ACP](https://agentclientprotocol.com) over `grok agent stdio`, so approvals, tool calls,
diffs, and plans arrive as typed JSON instead of characters on a screen.

|  | Existing tools | grokrc |
|---|---|---|
| Transport | PTY bytes | ACP JSON-RPC (typed) |
| "Is it waiting on me?" | regex over ANSI | `session/request_permission` |
| Approving a tool | send keystrokes, hope | one tap, answered by `optionId` |
| Networking | inbound port + Tailscale | agent dials **out** — nothing exposed |
| Shared session | separate/mirrored | `agent leader` — laptop + phone, **one** backend |
| Watch a hand-started TUI session | ✗ | ✓ read-only via `updates.jsonl` |
| Platforms | iOS (Android "in development") | PWA — both, day one |
| Grok Build | unsupported | native |

---

## Install

```bash
git clone <this repo> && cd grokrc
npm install && npm run build
npm link            # puts `grokrc` on your PATH
```

Requires [Grok Build](https://docs.x.ai/build/overview) on your PATH:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

## Use

```bash
grokrc doctor       # verify grok is installed and ACP responds
grokrc up --lan     # start the daemon, reachable from your phone
```

It prints a URL and a 6-character pairing code. Open the URL on your phone, enter the code,
add it to your home screen. That's it.

```
  grokrc listening on http://192.168.1.24:4319
  ⚠ bound to all interfaces — keep this on a trusted network or a Tailnet.

  No paired devices. Open the URL above on your phone and enter:

      Y8M8GF
```

| Command | |
|---|---|
| `grokrc up` | start daemon · `--lan` `--port` `--leader` `--model` `--cwd` |
| `grokrc devices` | list paired devices |
| `grokrc revoke <id>` | revoke one device (`--all` for everything) |
| `grokrc doctor` | check grok + ACP handshake |

**`--leader`** attaches to a running `grok agent leader` so your terminal TUI and your phone
drive the *same* session. Start something on your laptop, approve it from the couch.

---

## How it works

```
   ┌──────────────┐                                    ┌─────────────────┐
   │  Phone PWA   │── ws ──────────────────────────────│  grokrc daemon  │
   └──────────────┘   (LAN / Tailnet, or via relay)    └────────┬────────┘
                                                                │ ACP JSON-RPC
                                                       ┌────────▼────────┐
                                                       │   grok agent    │
                                                       └─────────────────┘
```

The daemon owns `grok agent stdio`, normalizes ACP into a small stable event union
(`text · thinking · tool · plan · approval · status`), and fans it out over an
authenticated WebSocket. The PWA renders those events as real UI.

**Pending approvals are state, not events.** Your phone is usually asleep when the agent
asks to run something. If approvals were only streamed, the request would arrive with
nobody listening and the agent would block forever. Every unanswered
`session/request_permission` is held and replayed on connect.

See [`docs/00-research.md`](docs/00-research.md) for the landscape and
[`docs/01-architecture.md`](docs/01-architecture.md) for the design.

---

## Security

Remote control of a coding agent **is** remote code execution. Treated accordingly:

- Pairing codes are **single-use** and expire in 5 minutes.
- Only a **SHA-256 hash** of each device token is persisted; comparison is constant-time.
- Binds to **loopback by default**; `--lan` is opt-in and warns.
- Static file serving is confined to `web/` (traversal is tested).
- `~/.grok/auth.json` is used by the local agent only — **never proxied to a client**.
- Default-deny permissions. The daemon never passes `--always-approve` or
  `bypassPermissions` on its own. Remote approval means a human tapping a button.

Do not expose the port directly to the public internet. Use a Tailnet, or relay mode
once it lands.

---

## Status

Working today:

- ✅ ACP client — handshake, sessions, prompts, cancel, fs bridge (verified against `grok 0.2.118`)
- ✅ Event normalizer with unknown-kind passthrough
- ✅ Session manager — owned + shared modes, replayable history, held approvals
- ✅ Pairing, device tokens, authenticated WebSocket
- ✅ PWA — session list, streaming, tool cards, plans, one-tap approvals
- ✅ 19 tests; `npm run build` and `grokrc doctor` green

Next:

- Observed mode — tail `~/.grok/sessions/**/updates.jsonl` for sessions started by hand
- Relay mode — `grok agent headless --grok-ws-url`, so no inbound port at all
- Web Push on approval requests (self-hosted VAPID, no third-party cloud)
- `grokrc pair` against a live daemon (needs the control socket)

## Development

```bash
npm test          # 19 tests, no agent spawned
npm run typecheck
npm run probe     # capture real ACP frames -> docs/captures/
node --experimental-strip-types src/cli.ts up   # run from source, no build
```

`tools/acp-probe.mjs` records live protocol traffic. ACP is `protocolVersion: 1` with
vendor `x.ai/*` extensions that will drift — when it does, re-run the probe, update
`src/acp/protocol.ts`, and the rest of the codebase stays put.

MIT.
