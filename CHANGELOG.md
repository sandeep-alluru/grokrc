# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0: the minor version may change behaviour. Read the notes before upgrading.

## [Unreleased]

### Added

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

[unreleased]: https://github.com/sandeep-alluru/grokrc/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sandeep-alluru/grokrc/releases/tag/v0.1.0
