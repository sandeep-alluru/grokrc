# grokrc — open items

**2 of 19 closed.** Generated from `tools/backlog.mjs` —
edit that, then run `npm run backlog -- --write`. `npm run backlog -- --check`
fails if this file has drifted, so status cannot be claimed in one place and
contradicted in another.

Evidence classes: **VERIFIED** (observed, with what showed it) ·
**UNVERIFIED** (believed, with the check that settles it) · **UNKNOWN**.

Status: `open` · `done` · `accepted` (no action intended) · `not-a-limitation`.

---

## A · Automated coverage gaps  —  0/4 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `removeSessionDir()` has no test, so it cannot be registered as a guard | `open` | VERIFIED — src/cli.ts defines it; grep over test/ returns nothing |
| 2 | Terminal client's exit guard (`nothing to drive from here`) has no test | `open` | VERIFIED — src/term/client.ts has it, no test references it |
| 3 | Mock debt: 13 of 32 test files reference a mock/stub/fake | `open` | VERIFIED — directive-check.mjs reports it as DEBT under 03 law 4 |
| 4 | Real agents spawned outside `npm test` still write into the developer’s ~/.grok | `open` | VERIFIED — 3 dead-cwd groups reappeared: grokrc-pkgtest-*, grokrc-leadertest-*, grokrc-public-* |

## B · Never verified  —  0/5 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 5 | Node 20 and 21 untested; `engines` claims >=20 | `open` | UNVERIFIED — only Node 22 exists here. Settled by a CI matrix |
| 6 | macOS untested; README says "expected to work" | `open` | UNVERIFIED — no macOS machine. Settled by a macos-latest CI job |
| 7 | Relay mode never run against a real VPS | `open` | UNVERIFIED — covered in-process and in a browser, never over the internet |
| 8 | Android push never tested | `open` | UNKNOWN — no Android device available |
| 9 | Multi-file diff rendering and very long tool output unverified | `open` | UNVERIFIED — browser tests replay captured write/edit payloads only |

## C · Product gaps  —  0/3 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 10 | `grokrc doctor` spawns its own probe agent instead of asking the running daemon | `open` | VERIFIED — src/cli.ts builds its own StdioTransport |
| 11 | `grokrc config set` requires a daemon restart to take effect | `open` | VERIFIED — src/cli.ts prints "restart to apply" |
| 12 | Android home-screen / notification docs are thin | `open` | VERIFIED — USER-GUIDE §10 covers iOS in depth, Android in two lines |

## D · Housekeeping  —  0/3 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 13 | /tmp/grokrc-handback and its throwaway session in ~/.grok | `open` | VERIFIED — directory present |
| 14 | Two pre-launch backup bundles in $HOME, 8.6 MB | `open` | VERIFIED — grokrc-pre-*.bundle |
| 15 | 3 dead-cwd session groups in ~/.grok (residue of #4) | `open` | VERIFIED — scan of ~/.grok/sessions |

## E · Reviewed after challenge  —  2/4 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 16 | A malicious relay can serve modified JavaScript | `open` | VERIFIED — the relay serves the PWA (src/relay/server.ts). Installing the client from the daemon’s origin removes the attack |
| 17 | A relay sees routing metadata — sizes, timing, endpoints | `accepted` | Inherent: a relay cannot route what it cannot see. Sizes could be padded; routes and timing cannot be hidden without cover traffic |
| 18 | Observed mode is read-only while mirroring | `not-a-limitation` | Correct architecture — no ACP channel to an agent the daemon did not spawn. Take over closes it and is verified on a real TUI |
| 19 | A turn killed mid-flight may lose its tail; recovery on resume is unverified | `open` | UNVERIFIED — no test covers it, and Take over kills the agent mid-turn BY DESIGN, so this is on the main path |

---

## Still open — 17

- **#1** `removeSessionDir()` has no test, so it cannot be registered as a guard
- **#2** Terminal client's exit guard (`nothing to drive from here`) has no test
- **#3** Mock debt: 13 of 32 test files reference a mock/stub/fake
- **#4** Real agents spawned outside `npm test` still write into the developer’s ~/.grok
- **#5** Node 20 and 21 untested; `engines` claims >=20
- **#6** macOS untested; README says "expected to work"
- **#7** Relay mode never run against a real VPS
- **#8** Android push never tested
- **#9** Multi-file diff rendering and very long tool output unverified
- **#10** `grokrc doctor` spawns its own probe agent instead of asking the running daemon
- **#11** `grokrc config set` requires a daemon restart to take effect
- **#12** Android home-screen / notification docs are thin
- **#13** /tmp/grokrc-handback and its throwaway session in ~/.grok
- **#14** Two pre-launch backup bundles in $HOME, 8.6 MB
- **#15** 3 dead-cwd session groups in ~/.grok (residue of #4)
- **#16** A malicious relay can serve modified JavaScript
- **#19** A turn killed mid-flight may lose its tail; recovery on resume is unverified
