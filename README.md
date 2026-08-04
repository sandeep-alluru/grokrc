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

### ⚠️ Required config — Grok does not ask for permission by default

Found the hard way, by driving a real turn end-to-end: **`[features]
support_permission` defaults to `false`**, and a user config may also set
`[ui] permission_mode` to `auto` / `dontAsk` / `bypassPermissions` /
`acceptEdits`. Under any of those, `session/request_permission` is never sent —
so one-tap approval silently does nothing *and* your agent executes every write
and shell command unattended.

Put this in `~/.grok/config.toml`:

```toml
[features]
support_permission = true

[ui]
permission_mode = "default"
```

`grokrc doctor` checks this and `grokrc up` refuses to be quiet about it.

```bash
grokrc doctor       # verify grok, ACP, and that the agent will actually prompt
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

- ✅ ACP client — handshake, sessions, prompts, cancel, fs bridge (verified against `grok 0.2.118`)
- ✅ Event normalizer with unknown-kind passthrough
- ✅ Session manager — owned, shared, and **observed** modes; replayable history; held approvals
- ✅ Pairing, device tokens, authenticated WebSocket
- ✅ PWA — session list, streaming, tool cards, plans, one-tap approvals
- ✅ **Observed mode** — mirrors sessions you started by hand in a terminal
- 🟡 **Relay mode** — transport works and is tested, but the PWA isn't served or paired
  through it yet, so it isn't usable end-to-end
- 🟡 **Web Push** — plumbing complete and tested; real delivery to a device unverified
- ✅ **Verified end-to-end against a live agent** — real turn, real
  `session/request_permission`, approved from a remote client, agent proceeded
  (`tools/e2e-drive.mjs`, capture in `docs/captures/e2e-drive.json`)
- ✅ 49 tests; build, typecheck, and `grokrc doctor` green

Next: serve the PWA through the relay; e2e encryption; open the PWA in a real
browser; `grokrc pair` against a live daemon.

## Limitations

| | |
|---|---|
| PWA | **Never loaded in a browser.** Served and tested at the HTTP level, but zero visual/interaction verification. The riskiest remaining gap |
| Relay | Transport verified, but no static serving and no `/api/*` proxying — a phone can't load or pair the app through it yet. And no e2e encryption: the relay sees plaintext, so self-host it |
| Push delivery | Plumbing tested; never delivered to a real device. iOS needs HTTPS **and** add-to-home-screen (16.4+), so `--lan` over plain http won't do it |
| Shared mode | `--leader` is passed through but never exercised |
| Observed mode | Read-only by construction — a log file can't accept input |
| `grokrc pair` | Stub; prints guidance instead of issuing a code |
| Model coverage | Tested with one tool (`write`). Diff rendering for edits, and long/streaming output, unverified |

---

## Observed mode

Grok persists every ACP update to
`~/.grok/sessions/<encoded-cwd>/<id>/updates.jsonl`. grokrc tails it, so a session
running in a terminal window shows up on your phone **read-only** — with no
cooperation from that process and no change to how you work.

Verified against real logs on-disk: the file is one JSON-RPC frame per line
(`{"timestamp":…,"method":"session/update","params":{…}}`), and `params` is
byte-identical to the live wire format, so one normalizer serves both.

## Relay mode

```bash
# on a VPS
grokrc relay --port 8080

# on your dev machine — dials OUT, nothing listening locally
grokrc up --relay ws://your-vps:8080
```

> ⚠️ **Incomplete.** The relay forwards WebSocket frames only — it does not serve the
> PWA or proxy `/api/pair` and `/api/push/*`. So the transport works and is tested, but a
> phone cannot yet *load or pair* the app through a relay. Use `--lan` today. Fixing this
> means serving the web assets and proxying those routes through the relay.

> ⚠️ The relay sees plaintext. End-to-end encryption is designed but not implemented —
> self-host it and treat the host as trusted.

The relay is deliberately stupid: it forwards opaque frames between one daemon and
N clients in a room, and never parses ACP. **It is not a trust boundary** — a
relayed client still has to present a valid device token, which is tested.

> `grok agent headless --grok-ws-url` also works — the probe in
> `docs/captures/relay-probe.json` shows the agent speaking plain ACP over its own
> outbound socket. grokrc doesn't use it, because pointing the *agent* at a relay
> bypasses the daemon and loses event normalization and held approvals. Having the
> *daemon* dial out gets the same NAT traversal and keeps both.

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
