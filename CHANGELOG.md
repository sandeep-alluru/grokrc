# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: the minor version may change behaviour. Read the notes before upgrading.

## [Unreleased]

### Added

- **Take over a terminal session from your phone.** A session started with plain `grok`
  was visible but read-only, and taking it over meant stopping the TUI by hand — which
  is impossible when the point is that you are away from the machine. **Take over** now
  terminates the owning process and resumes the session with its history intact.
  Guarded: only a pid Grok's registry names as this session's owner, only if its
  `argv[0]` is actually `grok` (pids get recycled), never the daemon itself, and
  `SIGTERM` only — `SIGKILL` risks an unflushed `updates.jsonl`. Two taps to confirm.
- **Hand back to terminal.** Closes the session daemon-side and shows the exact
  `cd <cwd> && grok -r <id>` to reopen it in Grok's TUI. Usually unnecessary —
  `grokrc term --session <id>` drives the same session with nobody giving anything up.
- **Control socket** (`src/daemon/control.ts`) — a Unix domain socket at
  `~/.grokrc/control.sock` (mode `0600`) letting the CLI talk to the running daemon.
  `grokrc pair` issues a code without a restart; `grokrc devices` shows who is connected
  right now; `grokrc revoke` closes the revoked device's socket immediately instead of at
  its next reconnect. All three fall back to the on-disk store when no daemon is running.
  A stale socket left by a crashed daemon is reclaimed; a live one is never stolen.
- **Public repository packaging** — `LICENSE` (MIT), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue and pull-request templates, Dependabot.
- **`docs/USER-GUIDE.md`** — task-oriented guide for daily use.
- **`docs/TROUBLESHOOTING.md`** and **`docs/FAQ.md`**.
- **Push prompt row** — a tappable row in the session list that both requests
  notification permission (satisfying iOS's user-gesture requirement) and explains
  why push is unavailable when it is.

### Fixed

- **Push notifications could never be enabled on iOS.** `setupPush()` ran during page
  load, where `Notification.requestPermission()` is silently ignored on iOS. Permission
  stayed `default` and the app never subscribed, with no error anywhere.
- **A browser without `PushManager` was told nothing.** `renderPushPrompt()` returned
  early when the API was absent — which is every iOS Safari **tab**, since Apple exposes
  push only in home-screen apps. The row now always renders and names the fix.
  Regression test: `test/push-prompt.test.ts`.
- **The push prompt claimed to be a session.** It carried `class="session"`, so
  `page.click('.session')` in the real-stack resume check opened the notification row
  instead of a session and timed out. It is now `.notice`, with an assertion preventing
  recurrence.
- **`browser.test.ts` "turn completes" was flaky (~1 run in 2).** It waited for the tool
  card to turn green, then asserted on the agent's closing message — two different
  events. It now waits for the text it asserts on. Verified across five consecutive runs.

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

[unreleased]: https://github.com/sandeep-alluru/grokrc/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sandeep-alluru/grokrc/releases/tag/v0.1.1
[0.1.0]: https://github.com/sandeep-alluru/grokrc/releases/tag/v0.1.0
