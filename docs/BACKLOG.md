# grokrc — open items

**21 of 25 closed.** Generated from `tools/backlog.mjs` —
edit that, then run `npm run backlog -- --write`. `npm run backlog -- --check`
fails if this file has drifted, so status cannot be claimed in one place and
contradicted in another.

Evidence classes: **VERIFIED** (observed, with what showed it) ·
**UNVERIFIED** (believed, with the check that settles it) · **UNKNOWN**.

Status: `open` · `done` · `accepted` (no action intended) · `not-a-limitation`.

---

## A · Automated coverage gaps  —  8/8 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `removeSessionDir()` has no test, so it cannot be registered as a guard | `done` | VERIFIED — test/session-cleanup.test.ts, and the containment check is a proven guard |
| 2 | Terminal client's exit guard (`nothing to drive from here`) has no test | `done` | VERIFIED — test/term-exit.test.ts drives the real CLI against a real daemon over a real socket |
| 3 | Mock debt: 13 test files drive MockTransport, and nothing checked the capture still held | `done` | VERIFIED — enumerated all 39 test files to zero: 16 match the checker, but 3 of those match only inside COMMENTS (midturn.test.ts argues a replaying mock would be wrong; takeover.test.ts says "Real, not a stub"; relay-isolation.test.ts calls a real WebSocket a "fake daemon socket"). True count is 13/39. The mock captured grok 0.2.118; the installed agent is 1.0.0. |
| 4 | Real agents spawned outside `npm test` still write into the developer’s ~/.grok | `done` | VERIFIED — check:stranger runs leak-free (20 -> 20 sessions); the residual groups came from running test files DIRECTLY, which the wrapper never covered |
| 20 | CI had been failing on EVERY run since 2026-08-06 and nobody looked | `done` | VERIFIED — gh run list showed 10 consecutive failures across the public launch and two npm releases |
| 21 | Real-stack checks load dist/ but nothing warned when it was stale | `done` | VERIFIED — six consecutive false "still failing" results on #19 were the harness testing the previous build |
| 23 | A real-stack check reported 3 problems while `npm test` exited 0 | `done` | VERIFIED — midturn-check printed "3 PROBLEM(S)" and the suite passed; forcing a failure now exits 1 |
| 24 | A fix can sit on disk while the daemon keeps running the old code | `done` | VERIFIED — dist/server.js was built at 12:37:32; the daemon had started at 12:31:57 and was still serving the pre-fix code when the owner was told it was live |

### 1 · `removeSessionDir()` has no test, so it cannot be registered as a guard

**Reanalyse — attacked.** The obvious test — 'it deletes the directory' — would have passed with the safety check removed, so it measures the wrong half. The interesting behaviour is the REFUSAL: removeSessionDir builds a delete path from a session id supplied from outside, then rm -rf's it. Attacked it with traversing ids ('..', '../../..', '../../../auth.json') and asserted a canary OUTSIDE the session store survives. Verified load-bearing: disabling the containment line makes the test fail.

**Result.** Exported removeSessionDir and covered three behaviours: it removes the throwaway session doctor creates, it REFUSES ids that escape the store (canary survives), and a missing session is a no-op rather than a throw — doctor calls it best-effort and tidying up must never fail the diagnostic. Guard session-cleanup-stays-in-the-store proven.

### 2 · Terminal client's exit guard (`nothing to drive from here`) has no test

**Reanalyse — attacked.** My first test hung, and my SECOND detector was also wrong — twice on one item. (1) `assert.equal(e.killed, false || undefined)` evaluates to `=== undefined`, so a clean non-zero exit, where killed is false, reported a hang that never happened. (2) Once fixed it exited 1 but printed 'no session matching does-not-exist' — a CLIENT-SIDE pre-check, not the guard. The guard fires on a daemon ERROR frame arriving before any session exists. A valid token can never reach it, so the test now uses a token the daemon REJECTS. Without that, the file would have gone green while the control stayed untested.

**Result.** The client exits non-zero and prints "no session opened — nothing to drive from here" instead of sitting with no prompt and no way to quit but ctrl-C (originally exit 124, killed by timeout). Guard term-exits-when-no-session-opened proven load-bearing.

### 3 · Mock debt: 13 test files drive MockTransport, and nothing checked the capture still held

**Reanalyse — attacked.** My leading diagnosis was "a major version bump means the capture has drifted and 13 files are green against a fiction." I built tools/acp-conformance.mjs to drive a REAL grok 1.0.0 and compare it against the claims read out of mock-transport.ts, and the diagnosis was REFUTED: every shape the mock asserts is still produced — agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, turn_completed — and the permission option kinds (allow_always, allow_once, reject_once) match the capture exactly. The mock is not lying. Then I attacked my own gate, which is where the real defect was: its assertion "every live kind normalizes to at least one event" passed 16/16 and was WORTHLESS, because normalizeSessionUpdate ends in `default: return [{k:"raw"}]` — true for every string that exists. A check that cannot fail certifies nothing, which is the same defect the item is about. Replaced it with a comparison against a measured, pinned surface, then proved that one CAN fail: dropping a kind from the pin exits 1, dropping a method exits 1, removing a kind from the opaque list exits 1, and the restored fixture is byte-identical with exit 0.

**Result.** The mocks are no longer unaccountable. tools/acp-conformance.mjs reads the mock’s claims from mock-transport.ts (never a hand-copied list), drives a real agent, and compares against test/fixtures/acp-surface.json — a MEASURED pin of 16 update kinds and 15 JSON-RPC methods on grok 1.0.0, reproduced identically across three runs. Wired into `npm test` via test:real, so the mock-backed files are now gated by a real-stack run in the default test command. Guard `turn-completion-is-understood` proves it load-bearing: disabling the turn_completed case in production makes the conformance check fail (verify-guards 21/21). Measured and now visible on every run: 9 of 16 live kinds reach the client as opaque `raw` events (hook_execution, interaction_resolved, last_turn_summary, model_changed, pending_interaction, response_completed, session_info_update, session_summary_generated, tool_call_delta_chunk), and 11 live kinds are exercised by no mock-backed test. 8 kinds new since 0.2.118 added to the declared union. Suite: 218 tests, 215 pass, 0 fail in both environments; the check skips loudly with no agent on PATH.

### 4 · Real agents spawned outside `npm test` still write into the developer’s ~/.grok

**Reanalyse — attacked.** Attacked my own fix: the isolated-test wrapper was assumed to cover the leak, so I measured check:stranger and it was clean — 20 sessions before and after. The leak was still recurring, which REFUTED "the wrapper is enough". Tracing the new group (grokrc-leadertest-Y6ANl9) showed it came from `node --test test/leader.test.ts` run directly while debugging: the wrapper only applies through npm scripts, and debugging never goes through them.

**Result.** leader.test.ts now refuses to spawn a real agent when GROK_HOME is unset or is the real home, and skips with a message naming the fix. Verified: running the file directly leaves the session count unchanged (20 -> 20), while `npm test` still exercises the leader for real (206/206, 0 skipped).

### 20 · CI had been failing on EVERY run since 2026-08-06 and nobody looked

**Analyse.** gh run list: every run back to 2026-08-06 red. Two distinct causes — test/leader.test.ts crashing the runner with `spawn grok ENOENT`, and four protocol-hardening tests timing out.

**Evaluate.** Candidates: (a) CI-only infrastructure flake, (b) tests genuinely need a real agent, (c) a defect in the tests themselves. The claim in CONTRIBUTING and ci.yml — "tests that need grok skip themselves, so CI stays green" — was itself a candidate, and it was FALSE.

**Reanalyse — attacked.** Attacked "CI-only flake" by reproducing the CI environment locally: PATH stripped of grok, full suite. It reproduced immediately — 3 failures — so flakiness was REFUTED and the failures were real. Then attacked my own fixes the same way after every change, which caught three regressions I introduced (a missed call site, an out-of-scope watcher, and a regex whose [^)]* could not span connect(clientUrl())). Also attacked the assumption that a passing test proves coverage: test/onboarding silently RETURNED without an agent, and a skipped test counts as a pass, which is why the doctor-login guard reported "passes without the control" on CI while passing locally.

**Reevaluate — survived.** Three real defects: spawn() emits ENOENT asynchronously so a try/catch could never catch it (the twin of the AcpClient unhandled-error bug); tests COUNTED websocket frames when the daemon broadcasts `sessions` on any list change; and watchers were attached AFTER send(), so a fast reply was dropped rather than queued.

**Decide.** One shared test/helpers/ws.ts with watch(), buffering from socket open and matching on content — replacing three private copies. Spawn error listeners in leader/takeover. relay.test.ts scripted so it no longer needs an agent it never tested. authHint() extracted as a pure function so its guard is provable without grok.

**Result.** CI environment reproduced locally (no agent on PATH): 201 pass, 0 fail, 3 skipped, exit 0. Developer environment: 204/204, both real-stack checks ALL CLEAR. Guards 15/15 in the CI environment, where one was previously unprovable.

### 21 · Real-stack checks load dist/ but nothing warned when it was stale

**Reanalyse — attacked.** Directive 11: the same signature five or more times is mechanism debt, not bad luck. I had blamed the product, then my assertions, then the event shapes — three wrong diagnoses in a row — before instrumenting and finding that my code was never executing. The recurring signature was "edit src/, run a real-stack check, observe no change". Attacked the idea that a comment or a habit would prevent it: both are HONOR-tier, and HONOR is what had just failed six times running.

**Reevaluate — survived.** bootDaemon() now compares the newest mtime in src/ against dist/ and THROWS rather than testing a stale build.

**Result.** PRE-FIX: `touch src/daemon/session-manager.ts` then run a check -> it ran happily against the old build. POST-FIX: "dist/ is 661s older than src/ — you are about to test the PREVIOUS build." After `npm run build` it proceeds and the check is ALL CLEAR.

### 23 · A real-stack check reported 3 problems while `npm test` exited 0

**Reanalyse — attacked.** reporter().finish() RETURNS an exit code, and three of the four tools do `const code = finish()`. The one I wrote discarded it, so that check could never fail the build — a gate certifying nothing, which is the same class of defect this sweep keeps surfacing. Attacked the narrow fix (use the return value in that one tool) as insufficient: it leaves the trap armed for the next tool, and HONOR is exactly what had just failed. Also checked the other three rather than assuming — they were correct, so this was not a widespread twin.

**Result.** finish() now sets process.exitCode as well as returning it, so a caller who drops the value still fails the build. Proven on known-bad input per directive 03: forcing a failure in midturn-check exits 1, where it previously exited 0.

### 24 · A fix can sit on disk while the daemon keeps running the old code

**Reanalyse — attacked.** The owner said the crash was not fixed. My first candidate was my own fix being wrong, and the second was their phone caching an old bundle — I had told them to reload. Both REFUTED by comparing two timestamps: the daemon started six minutes BEFORE the build it was supposed to be running. The code was correct and had simply never been loaded. This is the deployment-side twin of #21, where the test harness read a stale dist/; I fixed the test path and did not look at the deploy path.

**Result.** The watchdog now compares dist/daemon/server.js mtime against the daemon start time and restarts when the build is newer. Proven: touch dist -> run watchdog -> pid 1617626 becomes 1617847, logged as "reloaded the current build". After the reload the crash fix measured 4.5 MB -> 0.50 MB, 2000 -> 301 events, 1,624,434 -> 218,000 characters rendered.

## B · Never verified  —  3/5 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 5 | Node 20 and 21 untested; `engines` claims >=20 | `done` | VERIFIED — CI matrix: dist on Node 20, 21, 22 and 24, ubuntu and macos, 8/8 green |
| 6 | macOS untested; README says "expected to work" | `done` | VERIFIED — the same matrix on macos-latest: 4 runtime jobs plus 2 full-suite jobs green |
| 7 | Relay mode never run against a real VPS | `open` | UNVERIFIED — covered in-process and in a browser, never over the internet |
| 8 | Android push never tested | `open` | UNKNOWN — no Android device available |
| 9 | Multi-file diff rendering and very long tool output unverified | `done` | VERIFIED — both halves were real defects, each reproduced before being fixed. Long output: server.ts broadcast the live event object raw, and a 200,000-character tool result crossed the wire whole (nested: 400,148). Multi-file: a real grok 1.0.0 capture shows one file write is THREE events under one toolCallId, the last carrying no title and no kind, so the renderer overwrote the filename with the normalizer fallback — measured labels ["tool","tool","tool","tool"]. |

### 5 · Node 20 and 21 untested; `engines` claims >=20

**Reanalyse — attacked.** Attacked the obvious matrix design first: `node-version: [20, 22]` running `npm test` would FAIL on 20, because the suite uses --experimental-strip-types which does not exist before 22.6 — measuring the test framework, not the product. REFUTED. Also attacked omitting Node 21 as "short-lived": that is a reason to expect it works, not evidence, and `engines` admits it, so it is tested.

**Result.** compat.yml builds once on 22 then EXECUTES dist/ on 20, 21, 22, 24: --help, the engines floor, doctor failing cleanly, config naming defaultCwd, and up refusing without an agent. All 8 runtime jobs green.

### 6 · macOS untested; README says "expected to work"

**Reanalyse — attacked.** Attacked "macOS is basically Linux for a Node CLI" — untested is untested, and the systemd unit is genuinely Linux-only. Ran the real suite there rather than reasoning about it. What SURVIVED: the package and the full suite both work on macOS; only the systemd unit does not, which the docs already say.

**Result.** macos-latest covered for dist on all four Node versions AND the full suite on 22 and 24. README no longer says "expected to work".

### 9 · Multi-file diff rendering and very long tool output unverified

**Reanalyse — attacked.** Two of my own detectors were wrong on this item and both would have shipped a false story. (1) I read the multi-file capture with the tool id truncated to 12 characters, saw call-8f2e5c6 three times, and concluded every file collapsed into one row through a toolCallId collision. Re-measuring with FULL ids showed ...-0, ...-1, ...-2 — distinct. There is no collision; the truncation was mine. (2) I then ran the renderer test PRE-FIX, saw it fail, and nearly recorded that as proof: the failure was a bare 10s timeout, because the preceding test reloads the page onto the session list and the daemon only forwards events to a client WATCHING a session. The test never reached its assertions in either direction. After opening the session first, the honest PRE-FIX appeared — labels ["tool","tool","tool","tool"] — and POST-FIX passes. I also attacked the trim fix: the twin search found the broadcast loop in server.ts is the ONLY fan-out, so phones, `grokrc term` and relay clients are all covered by one change, and `s.log.push(ev)` runs before `emit`, so trimming a copy leaves stored history intact.

**Result.** Live events are now capped by the same trimEvent that history uses, applied once per event rather than once per client (test/live-event-size.test.ts: 200k -> capped, nested 400k -> capped, and a small event still arrives byte-for-byte so the cap cannot become a silent mangler). Tool rows now carry a RANKED label that never downgrades — naming files beats a title, which beats the generic word — so a finished row still says which file it wrote, and locations are shown when the title does not already name the path. Guards live-events-are-capped and tool-row-keeps-the-filename both proven load-bearing. Suite 222/222 with an agent, 219 pass 0 fail without one.

## C · Product gaps  —  5/5 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 10 | `grokrc doctor` spawns its own probe agent instead of asking the running daemon | `done` | VERIFIED — doctor reported "0 sent" while the daemon had delivered two; it now reports the daemon's live counters |
| 22 | Opening a long session crashed the phone — "A problem repeatedly occurred" | `done` | VERIFIED — the owner's x.com session is 1518 events / 9.97 MB; a real browser received 4.5 MB and rendered 1.6 million characters |
| 25 | Issuing a pairing code destroyed the one being typed | `done` | VERIFIED — auth.ts held ONE pending slot; beginPairing() overwrote it. 29 half-finished device pairings accumulated while the owner was told "invalid" |
| 11 | `grokrc config set` requires a daemon restart to take effect | `done` | VERIFIED live against the running daemon: `config set historyLimit 250` -> "applied to the running daemon — no restart needed", while `config set lan false` -> "the daemon is already bound to its address: restart to apply". Both settings restored afterwards and the daemon stayed healthy. |
| 12 | Android home-screen / notification docs are thin | `done` | VERIFIED — and thinness was the least of it. FAQ.md asserted Android push "is straightforward there" while this very file recorded #8 as open with "UNKNOWN — no Android device available": the repo shipped a claim and the record contradicting it. FAQ also said "153 tests" and README "204 tests" against a suite that had moved on. |

### 10 · `grokrc doctor` spawns its own probe agent instead of asking the running daemon

**Reanalyse — attacked.** Attacked the item as written — "doctor spawns its own probe" — and REFUTED it as the thing that matters. Removing the self-probe would break the most common case: a new user runs `grokrc doctor` BEFORE `grokrc up`, with no daemon to ask. What survived was a sharper defect underneath: doctor loads its own PushService from disk, and delivery counters (sent/failed/expired) live only in the daemon's memory. Measured it rather than reasoned about it — the daemon had delivered two pushes and doctor printed "0 sent, 0 failed, 0 expired". Then attacked my own first fix twice: it printed the push line TWICE (live and disk), and it sat AFTER the missing-agent early return, so a box without grok never saw the daemon report at all — which also made it untestable on CI, where the test initially failed for exactly that reason.

**Result.** doctor now asks the control socket FIRST, before even the agent check, and reports pid, address, live sessions, connected/paired devices and real delivery counters. The disk fallback runs only when no daemon answers and says so explicitly. test/doctor-daemon.test.ts drives the real CLI against a control socket reporting 41 sent — a number no disk-reading process could invent — and asserts the disk fallback did NOT run. Guard doctor-asks-the-running-daemon proven load-bearing.

### 22 · Opening a long session crashed the phone — "A problem repeatedly occurred"

**Reanalyse — attacked.** The reported symptom was "clicking a notification crashes the page", so the notification path was the obvious suspect. Measured instead of assumed: the screenshot URL was /?session=..., the COLD-LAUNCH openWindow path — and grep shows app.js never reads that query param, so the deep link is dead code and could not be the crash. What survived was size: historyLimit caps how many SESSIONS are listed and NOTHING capped the events sent for one. Then attacked my own first fix — a per-event cap on `.text` — which changed the measured payload by EXACTLY NOTHING, because the bulk lives in tool_call_update at content[].newText, rawOutput and _meta.details. Only walking the whole event moved the number.

**Result.** Two caps in server.ts: the last 300 events, with a marker naming how many were dropped, and a 4000-character ceiling on any string anywhere in an event. Measured on the real transcript: 9.97 MB -> 2.16 MB -> 1.65 MB, a 6x reduction; in a real browser 4.5 MB -> 0.7 MB, DOM nodes 1446 -> 242.

### 25 · Issuing a pairing code destroyed the one being typed

**Reanalyse — attacked.** Blamed the daemon, then the network, then the owner's phone — in that order, and all three were REFUTED by measurement: a code redeemed over the tailnet URL returned HTTP 200 with a real token, one daemon was listening, and tailscale proxied straight to it. The device list then showed pairings SUCCEEDING repeatedly (21 -> 29), which killed the "pairing is broken" framing entirely. Two separate causes were hiding behind one symptom: a single pending slot, so every code I helpfully issued killed the one being typed; and the phone running a CACHED bundle I had shipped and withdrawn, which paired fine and then could not reach the session list. The daemon logs named the second one outright — "stale client: device 27d3 is running bf983bb526b4, current is c59cc9bb52f1".

**Result.** Up to 8 codes can be outstanding at once, each with its own expiry, each still single use, oldest evicted first. Redemption compares against every candidate in constant time so a match does not depend on issue order. Guard pairing-codes-do-not-cancel-each-other proven load-bearing: restoring the single-slot behaviour fails test/pairing-codes.test.ts.

### 11 · `grokrc config set` requires a daemon restart to take effect

**Reanalyse — attacked.** The feature was already implemented, so the lazy pass was to mark it done and move on. Attacking it instead: I registered guards for its two controls and BOTH came back UNPROVEN — test/config-reload.test.ts passed with `server.applyConfig({historyLimit})` deleted AND with the entire needsRestart loop deleted. Reading it showed why: the test defined its own `reload` handler inline (lines 41-54) and asserted against that. It was a forked copy of the production logic, so it measured itself and could never fail for anything src/cli.ts did — a green test proving nothing, which is exactly what directive 03 exists to catch. Two further detector errors surfaced while fixing it: my first rewrite wrote a PARTIAL config file, so `port: undefined` looked like a change and needsRestart was non-empty for the wrong reason; and once corrected, `applied` came back as [defaultCwd, historyLimit] on a reload that only changed defaultCwd — production pushed historyLimit unconditionally while checking defaultCwd for an actual change.

**Result.** The logic moved into one implementation, `applyReload` in src/daemon/config.ts, which cli.ts now calls; the test drives that exported function with recorders instead of reimplementing it. historyLimit is now reported only when it actually changed, matching how defaultCwd already behaved, so a reload no longer claims to have applied a setting the user never touched. Tests went 2 -> 4, covering the historyLimit branch and the nothing-changed case that the old file left uncovered. Guards config-reload-reaches-the-daemon and config-reload-admits-what-it-cannot-apply now both prove load-bearing, having failed to before. Suite 224/224 with an agent, 221 pass 0 fail without one.

### 12 · Android home-screen / notification docs are thin

**Reanalyse — attacked.** Treating this as a writing task was the lazy pass — more prose rots the same way the two lines did. So the question became: what DETECTS the rot? Building that detector caught three of my own errors in a row. (1) My first version demanded an exact sentence in both docs; it failed on the docs I had just written, because one says it inside a wrapped blockquote with markdown bold — the detector was wrong, not the docs, so it now normalises before matching. (2) I shipped a DEAD ANCHOR in the same edit — a link to #why-the-notification-row-says-push-is-unavailable, a heading that never existed — which is what motivated a link checker at all. (3) That checker then reported three LIVE anchors as dead, because my slug collapsed runs of spaces while GitHub emits one hyphen per space: removing an em-dash leaves two spaces and therefore two hyphens. That exact slug bug had already bitten this repo once, in the README table of contents, which makes it mechanism debt rather than bad luck.

**Result.** Android now has a real section: Chrome/Firefox/Edge/Samsung Internet, the optional Add to Home screen, the HTTPS requirement, and the battery-optimisation setting that silently delays notifications — plus an explicit statement that none of it has been exercised on a physical device, naming `grokrc doctor` as the check that would settle it. test/docs.test.ts is the new mechanism, and every one of its four checks was proven to FAIL on known-bad input before being trusted: a reintroduced hardcoded count, a reintroduced "push is straightforward" claim, a removed untested-caveat, and a deliberately dead anchor. The Android caveat check reads backlog #8 status from the DATA, so closing #8 retires the requirement automatically instead of leaving a stale rule behind. Suite 228/228 with an agent, 225 pass 0 fail without one.

## D · Housekeeping  —  2/3 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 13 | /tmp/grokrc-handback and its throwaway session in ~/.grok | `done` | VERIFIED — directory removed |
| 14 | Two pre-launch backup bundles in $HOME, 8.6 MB | `open` | VERIFIED — grokrc-pre-*.bundle |
| 15 | 3 dead-cwd session groups in ~/.grok (residue of #4) | `done` | VERIFIED — 4 dead-cwd groups removed; a fresh scan finds none |

### 13 · /tmp/grokrc-handback and its throwaway session in ~/.grok

**Reanalyse — attacked.** Checked first whether anything still referenced it: the ~/.grok session pointing at it was in the dead-cwd set being cleared in the same pass, so removing the directory orphaned nothing.

**Result.** /tmp/grokrc-handback removed along with its session group.

### 15 · 3 dead-cwd session groups in ~/.grok (residue of #4)

**Reanalyse — attacked.** Attacked the idea that clearing them was sufficient: the same residue had already been cleared once and came back, so deleting without closing the source would just repeat. Held this until #4 was actually fixed, then cleared.

**Result.** 4 groups removed (grokrc-pkgtest-DXc5, grokrc-leadertest-gkXRVV, grokrc-leadertest-Y6ANl9, grokrc-public-uNy4). Session count stable at 15 across a subsequent full run.

## E · Reviewed after challenge  —  3/4 closed

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 16 | A malicious relay can serve modified JavaScript | `open` | VERIFIED — the relay serves the PWA (src/relay/server.ts). Installing the client from the daemon’s origin removes the attack |
| 17 | A relay sees routing metadata — sizes, timing, endpoints | `accepted` | Inherent: a relay cannot route what it cannot see. Sizes could be padded; routes and timing cannot be hidden without cover traffic |
| 18 | Observed mode is read-only while mirroring | `not-a-limitation` | Correct architecture — no ACP channel to an agent the daemon did not spawn. Take over closes it and is verified on a real TUI |
| 19 | A turn killed mid-flight may lose its tail; recovery on resume is unverified | `done` | UNVERIFIED — no test covers it, and Take over kills the agent mid-turn BY DESIGN, so this is on the main path |

### 19 · A turn killed mid-flight may lose its tail; recovery on resume is unverified

**Reanalyse — attacked.** Attacked the README's own explanation first — "Grok may not have flushed its last message; resuming replays from the agent and recovers it". BOTH halves were REFUTED. The tail was lost in OUR code: streaming text is coalesced in s.stream and only reaches s.log when the stream ENDS, so closing mid-turn dropped a buffer the user had already watched fill; and resume recovered nothing because there was nothing left to recover. Then attacked my own harness four separate times, each of which had produced a confident wrong answer: it counted the USER's echoed prompt as agent output so the kill landed before the agent spoke; it filtered history on the wrong event kinds; it read history() after close and mistook the observed-log fallback for evidence; and — six consecutive false "still failing" runs — bootDaemon loads dist/ while I was editing src/, so every result described the PREVIOUS build. Only instrumenting #retainLog and #recoverLostTail exposed that: NEITHER line printed, which is impossible if the code had run at all. Finally attacked the first version of the regression test, which passed with the control disabled because a replaying mock cannot express "the agent never persisted this".

**Reevaluate — survived.** Flush the coalesced stream before close() retains it; keep the witnessed log bounded (400 events x 8 sessions); on resume, put back ONLY what loadSession did not replay, since duplicating a transcript is worse than losing its tail.

**Result.** Real agent, tools/midturn-check.mjs — PRE-FIX: streamed "1..22", resumed history 0 chars. POST-FIX: "recovered 2 event(s) the agent never persisted", resumed history 71 chars, last streamed line survived, ALL CLEAR. Now part of test:real. test/midturn.test.ts drives an agent whose session/load replays NOTHING, so retention is the only path by which the text can return; guard flush-before-retain is proven load-bearing.

---

## Still open — 4

- **#7** Relay mode never run against a real VPS
- **#8** Android push never tested
- **#14** Two pre-launch backup bundles in $HOME, 8.6 MB
- **#16** A malicious relay can serve modified JavaScript
