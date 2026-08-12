# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: the minor version may change behaviour. Read the notes before upgrading.

## [Unreleased]

## [0.2.0] — 2026-08-12

First multi-platform release after 0.1.2. Full suite green on Linux, macOS, and Windows
in CI. Hand-back can open a **new** OS terminal with `grok -r` instead of only showing
a copy-paste command.

### Added

- **Windows support** — full test suite in CI, Scheduled Task installer scripts, named-pipe
  control channel (no Unix sockets), Windows-specific packaging under `packaging/windows/`.
- **Hand-back auto-relaunch** — after Give back, the daemon opens a new terminal running
  `grok -r <session>` (Windows CMD path, macOS Terminal.app, Linux `gnome-terminal` and
  other emulators). Phone shows a sticky release card with bash / PowerShell / `grokrc term`
  fallbacks when auto-open fails.
- **Quiet live events** — client-facing stream filters Grok 1.0 metadata noise and caps
  string sizes so long sessions do not crash mobile Safari.
- **Daemon resilience** — survives device-store / subscription write failures; reloads when
  `dist/` is newer than the running process (watchdog helpers).
- **Docs** — root `SETUP.md` with platform blocks, `docs/WINDOWS.md`, handoff / megasession
  notes, bug-spec tracker for Windows hand-back.

### Fixed

- **Linux hand-back did not open a terminal** — stale daemon never loaded relaunch code;
  Linux path now prefers `gnome-terminal`, requires a graphical session env, and waits for
  a confirmed spawn instead of reporting success on the first `spawn()` return.
- **Take over / hand-back** on Windows (blank CMD, title-token pitfalls, process identity).
- Pairing codes no longer cancel each other; long-session crash (event size); mid-turn
  tail loss; live tool rows losing filenames; config reload testability; CI without `grok`
  on PATH; EPIPE / transport stand-in after default `--permission-mode`.

### Changed

- Default agent spawn includes `--permission-mode default` so remote approval has a chance
  when Grok user config allows it (still requires `support_permission` / non-auto UI mode
  in `~/.grok/config.toml`).

## [0.1.2] — 2026-08-10

### Fixed

- **Push notifications never reached an iPhone.** The VAPID subject shipped as
  `mailto:grokrc@localhost`. Apple validates the JWT `sub` claim and rejects a
  non-routable address with a bare `403`; Mozilla does not check, so desktop
  browsers worked and iOS silently failed — which looked exactly like an iOS
  permissions problem. The default is now `https://github.com/sandeep-alluru/grokrc`,
  overridable with `GROKRC_VAPID_SUBJECT`.

  Existing installs are **repaired on load**. The subject is part of the signed
  token, not the key pair, so no device has to re-subscribe.

  Verified end to end: delivered to a real iPhone and confirmed received —
  `sent: 2, failed: 0`, where the same send was `sent: 1, failed: 1` before.

### Added

- The notification row shows the raw facts when push is unavailable
  (`installed · pushAPI · sw · https · permission`), so one screenshot explains
  a failure instead of a round trip.

## [0.1.1] — 2026-08-10

Onboarding fixes, found by installing 0.1.0 into a fresh HOME with no agent and
no credentials — a state the author's machine can never be in.

### Fixed

- **`grokrc up` started with no agent installed.** It printed a config warning
  and began listening, so a new user could pair a phone to a daemon that could
  not open a single session. It now refuses, names the install command, and does
  not announce itself as ready.
- **`grokrc doctor` relayed the agent's raw auth error** — `Authentication
  required (-32000)` — which is accurate and names no command. It now adds
  `run: grok login`.

### Added

- `npm run check:stranger` — installs the package into a fresh HOME with a
  system-only PATH and asserts the first-run experience. Two of its own
  assertions were false-passing on the first run and were tightened.
- `npm run check:live` — drives the running daemon in a real browser.
- `npm run verify:guards` — disables each load-bearing control and requires its
  test to fail.

### Verified

Compatible with **Grok Build 1.0.0** as well as 0.2.118: ACP handshake,
`loadSession`, `session/new`, full suite 199/199, both real-stack checks clear.

## [0.1.0] — 2026-08-04

First working release. Private.

### Added

- **ACP client** over `grok agent stdio` — NDJSON transport with chunk-boundary
  reassembly, an 8 MiB line cap, and EPIPE handling that no longer takes down the daemon.
- **Session manager** — owned, shared, and observed modes; resume via `session/load`;
  a 12-session live cap; `cwd` validation on both create and resume.
- **Daemon + WebSocket server** — device pairing, per-message shape validation, typed
  event stream to clients.
- **Progressive web app** — renders tool calls, plans, diffs, and permission requests as
  real UI rather than a terminal emulator. One-tap approvals answered by `optionId`.
- **Observed mode** — mirrors a hand-started Grok TUI session read-only by tailing
  `updates.jsonl`, with correct UTF-8 handling across read boundaries.
- **Relay mode** — the daemon dials **out**, so nothing listens locally. End-to-end
  encrypted with AES-256-GCM; the key travels in the URL fragment, which browsers never
  transmit, so the relay routes traffic it cannot read.
- **Web Push** — self-hosted VAPID, with subscription pruning only on 404/410.
- **`grokrc term`** — a terminal client on the same session the phone drives.
- **systemd user service** — survives reboot.
- **Preflight check** — detects `support_permission = false` and
  `permission_mode = "auto"`, either of which silently disables approvals.

### Known limitations

- `grokrc pair` cannot reach a running daemon; restart with `--pair` to issue a code.
- Grok's TUI cannot join a shared backend — verified four ways. Use `grokrc term`.
- iOS push requires Safari plus Add to Home Screen. No third-party iOS browser supports
  Web Push.

[unreleased]: https://github.com/sandeep-alluru/grokrc/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sandeep-alluru/grokrc/releases/tag/v0.2.0
[0.1.2]: https://github.com/sandeep-alluru/grokrc/releases/tag/v0.1.2
[0.1.1]: https://github.com/sandeep-alluru/grokrc/releases/tag/v0.1.1
[0.1.0]: https://github.com/sandeep-alluru/grokrc/releases/tag/v0.1.0
