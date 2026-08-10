# grokrc — open items

Everything known to be outstanding as of **2026-08-10**, after the 0.1.2 release.
N = 19 items, all listed; nothing summarised away.

Section E was re-examined after the question "why are we accepting these?" —
#16 and #19 moved to open, #18 turned out not to be a limitation at all.

Each row states its evidence class, because "we should probably…" is how a gap
gets carried forward forever:

- **VERIFIED** — observed, with the command or output that showed it
- **UNVERIFIED** — believed, with the exact check that would settle it
- **UNKNOWN** — no basis either way; saying so is the honest answer

Status: `open` · `accepted` (documented, no action intended) · `done`

---

## A · Automated coverage gaps

These are controls that exist and work, but nothing would notice if they broke.

| #   | Item                                                                                                                                                            | Evidence                                                                                              | Status | Effort |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ | ------ |
| 1   | `removeSessionDir()` (stops `doctor` littering a session per run) has **no test**, so it cannot be registered as a guard                                        | VERIFIED — `src/cli.ts` has it, `grep -rl` over `test/` returns nothing                               | open   | S      |
| 2   | Terminal client's exit guard (`nothing to drive from here`) has **no test**                                                                                     | VERIFIED — `src/term/client.ts` has it, no test references it                                         | open   | S      |
| 3   | Mock debt: **13 of 32** test files reference a mock/stub/fake (11 of 30 `*.test.ts` use `MockTransport`)                                                        | VERIFIED — `directive-check.mjs` reports it as DEBT under 03 law 4                                    | open   | L      |
| 4   | Real agents spawned **outside** `npm test` still write into the developer's `~/.grok` — `check:stranger` and the package tests bypass `tools/isolated-test.mjs` | VERIFIED — 3 dead-cwd groups reappeared: `grokrc-pkgtest-*`, `grokrc-leadertest-*`, `grokrc-public-*` | open   | S      |

> **#4 is a twin I missed.** The isolation wrapper was built for `npm test` and
> the same leak exists on a second path. Fixing one instance of a class and not
> looking for the other is exactly what directive 07 law 4 is for.

## B · Never verified

Real capability claims with no evidence behind them. Any of these could be
broken today and nobody would know.

| #   | Item                                                 | Evidence                                                                  | Status | Effort |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------- | ------ | ------ |
| 5   | **Node 20 and 21** — `engines` claims `>=20`         | UNVERIFIED — only Node 22.22.2 exists here. Settled by a CI matrix        | open   | S      |
| 6   | **macOS** — README says "expected to work"           | UNVERIFIED — no macOS machine. Settled by a `macos-latest` CI job         | open   | S      |
| 7   | **Relay mode against a real VPS**                    | UNVERIFIED — covered in-process and in a browser, never over the internet | open   | M      |
| 8   | **Android push**                                     | UNKNOWN — no Android device available                                     | open   | M      |
| 9   | Multi-file diff rendering, and very long tool output | UNVERIFIED — browser tests replay captured `write`/`edit` payloads only   | open   | M      |

> #5 and #6 are the cheapest wins on this page: a CI matrix converts two
> unknowns into facts with no hardware and no new test code.

## C · Product gaps

| #   | Item                                                                                                        | Evidence                                                                      | Status | Effort |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ | ------ |
| 10  | `grokrc doctor` spawns its **own** probe agent instead of asking the running daemon over the control socket | VERIFIED — `src/cli.ts:492` builds a `StdioTransport`                         | open   | M      |
| 11  | `grokrc config set` requires a daemon restart to take effect                                                | VERIFIED — `src/cli.ts:439` prints "restart to apply"                         | open   | M      |
| 12  | Android home-screen / notification docs — the guide is iOS-heavy                                            | VERIFIED — `docs/USER-GUIDE.md` §10 covers iOS in depth, Android in two lines | open   | S      |

## D · Housekeeping

| #   | Item                                                                            | Evidence                              | Status | Effort |
| --- | ------------------------------------------------------------------------------- | ------------------------------------- | ------ | ------ |
| 13  | `/tmp/grokrc-handback` and its session in `~/.grok` (the MAGENTA-ORBIT-91 test) | VERIFIED — directory present          | open   | S      |
| 14  | Two pre-launch backup bundles in `$HOME`, 8.6 MB total                          | VERIFIED — `grokrc-pre-*.bundle`      | open   | S      |
| 15  | 3 dead-cwd session groups in `~/.grok` (the residue of #4)                      | VERIFIED — scan of `~/.grok/sessions` | open   | S      |

## E · Reviewed after challenge

Originally filed as "accepted". Two of the four did not survive the question
_why are we accepting this?_ — which is the point of asking it.

| #   | Item                                                                                           | Verdict              | Evidence                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16  | A **malicious** relay can serve modified JavaScript                                            | **open**             | VERIFIED the relay serves the PWA (`src/relay/server.ts:156`). It does not have to: install the app from the DAEMON's origin over Tailscale and use the relay as transport only, and a hostile relay never serves code. A fix path exists, so "accepted" was too comfortable. Workaround today: self-host the relay                                                                                 |
| 17  | A relay sees routing metadata — sizes, timing, which endpoints                                 | accepted             | Inherent: a relay cannot route what it cannot see. Padding could blunt sizes; timing and routes cannot be hidden without cover traffic, which is out of scope for a personal tool                                                                                                                                                                                                                   |
| 18  | Observed mode is read-only while mirroring                                                     | **not a limitation** | Correct architecture — the daemon has no ACP channel to an agent it did not spawn. **Take over** closes the gap and is verified on a real TUI. Documented behaviour, not a defect                                                                                                                                                                                                                   |
| 19  | If the agent is killed mid-turn, Grok may not have flushed its last message to `updates.jsonl` | **open**             | The recovery claim ("resuming replays from the agent and recovers it") is UNVERIFIED — no test covers it. **Take over kills the agent mid-turn by design**, so this is on the main path, not an edge case; the owner hit it taking over a live session and lost the tail of a reply. SETTLED BY: prompt a session, kill the agent mid-stream, resume, diff the transcript against what was streamed |

---

## Suggested order

1. **#5, #6** — CI matrix (Node 20/22, ubuntu + macOS). Cheapest, and turns two unknowns into facts.
2. **#4, #15** — close the real-agent leak on its second path, then clear the residue.
3. **#1, #2** — tests for the two unguarded controls, then register both in `tools/guards.mjs`.
4. **#13, #14** — housekeeping.
5. **#10, #11** — control-socket commands; both are real papercuts.
6. **#19** — verify or refute the mid-turn recovery claim. It is on the Take over path.
7. **#16** — serve the client from the daemon, not the relay.
8. **#3, #7, #8, #9, #12** — larger, lower urgency.

Nothing here blocks use of the published package. 0.1.2 passes 204/204 tests,
15/15 guards, 14/14 stranger checks and 15/15 live checks, and iOS push is
verified on a real device.
