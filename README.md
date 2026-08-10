# grokrc

**Remote control for xAI's Grok Build CLI.** Drive your terminal coding agent from your
phone — over the agent's own protocol, not a screen scrape.

> Existing tools put a terminal on your phone. This puts the **agent** on your phone.

<p>
  <a href="https://github.com/sandeep-alluru/grokrc/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sandeep-alluru/grokrc/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen">
  <img alt="Tests" src="https://img.shields.io/badge/tests-204%20passing-brightgreen">
  <img alt="Status" src="https://img.shields.io/badge/status-pre--1.0-orange">
</p>

**[Setup](docs/SETUP.md)** · **[User Guide](docs/USER-GUIDE.md)** ·
**[Troubleshooting](docs/TROUBLESHOOTING.md)** · **[FAQ](docs/FAQ.md)** ·
**[Architecture](docs/01-architecture.md)** · **[Security](SECURITY.md)** ·
**[Contributing](CONTRIBUTING.md)**

<p align="center">
  <img src="docs/screenshots/sessions.png" alt="Session list" width="30%">
  <img src="docs/screenshots/live-turn.png" alt="A live turn" width="30%">
  <img src="docs/screenshots/approval.png" alt="One-tap approval" width="30%">
</p>
<p align="center"><em>Session list · a live turn · a real permission request, answered with one tap</em></p>

---

## Quickstart

```bash
# 1. the agent grokrc drives
curl -fsSL https://x.ai/cli/install.sh | bash
grok login

# 2. grokrc itself
npm install -g grokrc

# 3. where new sessions should open, then go
grokrc config set defaultCwd ~/code
grokrc up --lan
```

It prints a URL and a 6-character code. Open the URL on your phone, type the code.

```
  grokrc listening on http://192.168.1.24:4319

  No paired devices. Open the URL above on your device and enter:

      Y8M8GF
```

Stuck? `grokrc doctor` checks the agent, the protocol, and whether approvals will
actually fire. Full walkthrough in **[docs/SETUP.md](docs/SETUP.md)**.

---

## Why this exists

xAI shipped [Grok Build](https://github.com/xai-org/grok-build) in May 2026. It has no
remote control, and **no open-source project targets it** — every existing mobile client
(MobileCLI, Happy, CloudCLI, Orca) supports Claude Code and Codex only.

More importantly, they all work the same way: stream raw PTY bytes to a phone-sized
`xterm.js` and run a regex over the ANSI output to guess whether the agent is waiting for
you. MobileCLI literally documents a _"CLI Detection Engine"_ that _"parses output to
identify wait states."_

They screen-scrape because they must — Claude Code and Codex don't expose a structured
agent protocol. **Grok Build does.** It speaks
[ACP](https://agentclientprotocol.com) over `grok agent stdio`, so approvals, tool calls,
diffs, and plans arrive as typed JSON instead of characters on a screen.

|                                  | Existing tools                 | grokrc                                              |
| -------------------------------- | ------------------------------ | --------------------------------------------------- |
| Transport                        | PTY bytes                      | ACP JSON-RPC (typed)                                |
| "Is it waiting on me?"           | regex over ANSI                | `session/request_permission`                        |
| Approving a tool                 | send keystrokes, hope          | one tap, answered by `optionId`                     |
| Networking                       | inbound port + Tailscale       | agent dials **out** — nothing exposed               |
| Shared session                   | separate/mirrored              | `grokrc term` — terminal + phone on **one** backend |
| Take over a terminal session     | ✗                              | one tap — stops the TUI, keeps the history          |
| Give it back                     | ✗                              | `grokrc term --session <id>`, or one tap            |
| Watch a hand-started TUI session | ✗                              | ✓ read-only via `updates.jsonl`                     |
| Platforms                        | iOS (Android "in development") | PWA — both, day one                                 |
| Grok Build                       | unsupported                    | native                                              |

---

## Install

> **Full setup guide: [docs/SETUP.md](docs/SETUP.md)** — install, configure, reach it
> from your phone (LAN / Tailscale / relay), run it as a service, enable push,
> plus troubleshooting and the security model.

**From npm** — the normal way:

```bash
npm install -g grokrc
```

No global write access? Install without root:

```bash
npm config set prefix ~/.local          # once
npm install -g grokrc
export PATH="$HOME/.local/bin:$PATH"    # add this to your shell rc
```

**From source** — for contributors, or to run unreleased changes:

```bash
git clone https://github.com/sandeep-alluru/grokrc.git
cd grokrc
npm install && npm run build
npm link                       # puts `grokrc` on your PATH
```

**Either way**, grokrc drives [Grok Build](https://docs.x.ai/build/overview), so that
has to exist first — `grokrc up` refuses to start without it:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

Then set the one setting that has no default, and check the install:

```bash
grokrc config set defaultCwd ~/code    # required — grokrc will not guess
grokrc doctor                          # agent, ACP handshake, approvals
```

Node 20 or newer per `engines`, **developed and tested on Node 22** — 20 and 21 are
untested. Verified against `grok 0.2.118` and `1.0.0` on Linux. macOS is expected to
work but is untested here; the systemd unit is Linux-only.

## Use

### ⚠️ Required config — Grok does not ask for permission by default

Found the hard way, by driving a real turn end-to-end: **`[features]
support_permission` defaults to `false`**, and a user config may also set
`[ui] permission_mode` to `auto` / `dontAsk` / `bypassPermissions` /
`acceptEdits`. Under any of those, `session/request_permission` is never sent —
so one-tap approval silently does nothing _and_ your agent executes every write
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

### Configure it first — one setting is required

```bash
grokrc config set defaultCwd /path/to/your/projects
```

**This has no default and grokrc will not guess one.** Sessions started from your phone
open in the daemon's working directory — and under systemd that is your home directory,
not a project, so the agent begins with no repo in context. The daemon prints a notice
at startup until you set it.

```bash
grokrc config                    # show current settings
grokrc config set lan true       # bind 0.0.0.0 instead of loopback
grokrc config unset model
```

| Key                     |                                                   |
| ----------------------- | ------------------------------------------------- |
| `defaultCwd`            | **required** — working directory for new sessions |
| `port` · `host` · `lan` | where the daemon listens                          |
| `historyLimit`          | how many past sessions to list (default 10)       |
| `model`                 | model override for new sessions                   |
| `leader`                | share one backend with `grok agent leader`        |

Precedence: **CLI flag → `~/.grokrc/config.json` → built-in default.** Settings are
validated on write and on start — a `defaultCwd` that doesn't exist is refused rather
than silently ignored.

### Run it as a service

```bash
packaging/systemd/install.sh                    # loopback, behind a tunnel
packaging/systemd/install.sh -- --lan           # reachable on your LAN
```

A **user** unit, not a system one — it needs `~/.grok/auth.json` and must spawn agents as
you, so no sudo is involved. The installer enables lingering so it starts at boot and
survives logout.

```
systemctl --user status grokrc     journalctl --user -u grokrc -f
systemctl --user restart grokrc    packaging/systemd/uninstall.sh
```

Pair a device against a running service with `grokrc up --pair` (or edit
`~/.config/grokrc/grokrc.env` and restart).

| Command              |                                                              |
| -------------------- | ------------------------------------------------------------ |
| `grokrc up`          | start daemon · `--lan` `--port` `--leader` `--model` `--cwd` |
| `grokrc devices`     | list paired devices                                          |
| `grokrc revoke <id>` | revoke one device (`--all` for everything)                   |
| `grokrc doctor`      | check grok + ACP handshake                                   |

**Terminal + phone on one session** is `grokrc term`, not `--leader`. Grok's own TUI
**cannot** join a shared backend — verified four ways: it never connects to
`leader.sock`, `use_leader` appears nowhere in Grok's documentation, `grok inspect`
surfaces no leader config, and `grok --help` has no `--leader`. `grokrc term` works
around it by talking to the grokrc daemon, which is already a shared backend.

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
(see [docs/SETUP.md](docs/SETUP.md) §6).

---

## Status

- ✅ ACP client — handshake, sessions, prompts, cancel, fs bridge (verified against `grok 0.2.118` and `1.0.0`)
- ✅ Event normalizer with unknown-kind passthrough
- ✅ Session manager — owned, shared, and **observed** modes; replayable history; held approvals
- ✅ Pairing, device tokens, authenticated WebSocket
- ✅ PWA — session list, streaming, tool cards, plans, one-tap approvals
- ✅ **Observed mode** — mirrors sessions you started by hand in a terminal
- ✅ **Relay mode** — the relay serves the PWA and tunnels `/api/*`, so a phone with no
  route to your machine can load the app, pair, and drive a session
- ✅ **Web Push** — delivered to a real desktop browser AND a real iPhone; delivery to an iOS
  home-screen app is **confirmed on a real iPhone**
- ✅ **Verified end-to-end against a live agent** — real turn, real
  `session/request_permission`, approved from a remote client, agent proceeded
  (`tools/e2e-drive.mjs`, capture in `docs/captures/e2e-drive.json`)
- ✅ **Verified in a real browser** — Chromium at phone width loads the app, pairs,
  streams a turn, and taps an approval, both direct and through the relay
- ✅ **End-to-end encrypted through the relay** — verified by tapping every relayed frame
- ✅ **Shared-backend handoff verified** — two independent clients on one `grok agent leader`,
  the second loading a session created by the first
- ✅ 204 tests — unit, browser (real Chromium against the real PWA), and real-stack
  checks that drive an actual `grok` process; build, typecheck, and lint green

![approval screen](docs/screenshots/approval.png)

## Limitations

|                 |                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious relay | E2E encryption defeats a _passive_ relay, not one serving modified JS. Self-host it                                                                                                                             |
| Relay metadata  | Routes, message sizes, and timing are visible. Contents are not                                                                                                                                                 |
| Push on iOS     | Apple allows Web Push **only** in a home-screen app installed from **Safari**, over HTTPS. Chrome/Firefox/DuckDuckGo/Brave/Edge on iOS cannot do push at all. Delivery is verified on a real iPhone as of 0.1.2 |
| Observed mode   | Read-only while mirroring — use **Resume** to take it live                                                                                                                                                      |
| Log tail        | If the agent process is killed mid-turn, Grok may not have flushed its last message to `updates.jsonl`, so the read-only view can be missing it. Resuming replays from the agent and recovers it                |
| Tool coverage   | Browser tests replay captured `write`/`edit` payloads. Diff rendering for multi-file edits, and very long output, unverified                                                                                    |

### How the browser tests work

`test/browser.test.ts` and `test/relay-browser.test.ts` run the real PWA in Chromium
against a **scripted agent** (`src/acp/mock-transport.ts`) that replays payloads captured
verbatim from `grok 0.2.118` — including the genuine three-option permission request.
Realistic, deterministic, and free. `tools/e2e-drive.mjs` is the paid counterpart that
drives a live agent when you want the real thing.

Two bugs the browser found that DOM-free tests could not: a fresh session rendered as a
blank screen, and the header relabelled itself "Sessions" while inside a session because
the list re-render stole the title.

---

## Taking over a session from your phone

Start a session at your desk with plain `grok`, walk away, and it shows up on your
phone as **live in terminal** — read-only, because the daemon did not spawn it.

Tap **Take over** (twice; it stops a process on a machine you cannot see) and the
terminal's `grok` is stopped and the session resumes on your phone with its history
intact. Verified against real Grok: a codeword planted in the TUI and a second planted
after the takeover were both recalled afterwards.

It refuses to stop anything that is not Grok. Pids get recycled, and Grok's session
registry can name a dead one, so the daemon reads the process's `argv[0]` and declines
unless it is actually `grok`. `SIGTERM` only — `SIGKILL` risks losing the last message.

**Giving it back** is usually unnecessary:

```bash
grokrc term --session <id>     # terminal and phone drive it together
```

For Grok's own TUI, tap **⇄ Hand back to terminal**. The daemon closes the session —
it has to let go, or two agents end up on one conversation — and shows you the exact
`cd <cwd> && grok -r <id>` to paste.

## Resuming past sessions

Opening a past session shows it read-only with a **Resume session** button. Grok
advertises `loadSession`, so resuming reopens it as a genuinely live session with its
full context — not a new conversation. Verified end-to-end in
`tools/resume-check.mjs`: plant a codeword, kill the session, resume it from the UI, and
the agent still recalls it.

Without this, any session whose process had ended was permanently read-only — you could
read the transcript but never continue it.

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

It prints a phone URL. The relay serves the PWA itself and tunnels `/api/*` to the
daemon over its outbound socket, so a phone with **no route to your machine** can load
the app, pair, and drive a session. Verified in a real browser
(`test/relay-browser.test.ts`) with the daemon's own HTTP port never contacted.

### End-to-end encryption

The relay routes but cannot read. `grokrc up --relay` mints a secret and puts it in the
URL **fragment**:

```
http://relay.example/client?room=R&key=K#e=<secret>
                                        ^^^^^^^^^^^
                        browsers never send fragments to the server
```

Both ends derive an AES-256-GCM key from it (HKDF), and every WebSocket frame plus every
tunnelled `/api/*` body is sealed. `test/e2e-crypto.test.ts` taps every frame the relay
handles and asserts the prompt text, agent output, pairing code, device token, and ACP
structure appear in **none** of them.

The relay still sees routing metadata — that `/api/pair` was called, and message sizes and
timing. It cannot see contents.

> ⚠️ **What this does not defend against:** a _malicious_ relay serving modified
> JavaScript. The relay serves the client, so it could serve a version that leaks the key.
> Encryption cannot fix code delivery. Self-host the relay, or load the client once from
> the daemon over LAN. `--no-e2e` disables encryption and says so loudly.

The relay is deliberately stupid: it forwards opaque frames between one daemon and
N clients in a room, and never parses ACP. **It is not a trust boundary** — a
relayed client still has to present a valid device token, which is tested.

> `grok agent headless --grok-ws-url` also works — the probe in
> `docs/captures/relay-probe.json` shows the agent speaking plain ACP over its own
> outbound socket. grokrc doesn't use it, because pointing the _agent_ at a relay
> bypasses the daemon and loses event normalization and held approvals. Having the
> _daemon_ dial out gets the same NAT traversal and keeps both.

## Development

```bash
npm test          # 204 tests: mock suite -> build -> real-stack checks
npm run verify:guards  # disable each load-bearing control; its test must FAIL
npm run check:live     # drive the RUNNING daemon in a real browser
npm run typecheck
npm run probe     # capture real ACP frames -> docs/captures/
node --experimental-strip-types src/cli.ts up   # run from source, no build
```

`tools/acp-probe.mjs` records live protocol traffic. ACP is `protocolVersion: 1` with
vendor `x.ai/*` extensions that will drift — when it does, re-run the probe, update
`src/acp/protocol.ts`, and the rest of the codebase stays put.

---

## Documentation

| Document                                   | What is in it                                          |
| ------------------------------------------ | ------------------------------------------------------ |
| [Setup](docs/SETUP.md)                     | Install, configure, networking, run as a service       |
| [User Guide](docs/USER-GUIDE.md)           | Daily use — sessions, approvals, resume, notifications |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Symptom-first fixes                                    |
| [FAQ](docs/FAQ.md)                         | Short answers                                          |
| [Architecture](docs/01-architecture.md)    | How the daemon, ACP client, and observer fit together  |
| [Research](docs/00-research.md)            | Prior art, and why screen-scraping was rejected        |
| [Security](SECURITY.md)                    | Threat model and vulnerability reporting               |
| [Contributing](CONTRIBUTING.md)            | Dev setup and the bar for a change                     |
| [Changelog](CHANGELOG.md)                  | What changed                                           |

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first —
the bar for a bug fix is specific: **reproduce it, show a test failing before your fix
and passing after, and isolate which change was load-bearing.**

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? **Do not open a public issue.** See [SECURITY.md](SECURITY.md).

The most important security setting is not in grokrc at all — it is Grok's
`support_permission`, which defaults to **off**. With it off your agent acts without
asking anyone. `grokrc doctor` checks it.

## License

[MIT](LICENSE) © 2026 Sandeep Alluru

Not affiliated with xAI. "Grok" and "Grok Build" are trademarks of X.AI Corp.
