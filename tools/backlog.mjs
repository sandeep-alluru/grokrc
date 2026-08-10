/**
 * The backlog. DATA ONLY — `tools/backlog-report.mjs` renders and checks it.
 *
 * Single source of truth: `docs/BACKLOG.md` is GENERATED from this file, and
 * `test/backlog.test.ts` fails if the two drift. Keeping status in prose meant
 * an item could be called done in one place and open in another, and nothing
 * would notice.
 *
 * Per item:
 *   id        stable number, never reused
 *   section   A..E
 *   title     one line
 *   evidence  VERIFIED / UNVERIFIED / UNKNOWN, with what showed it
 *   status    open | done | accepted | not-a-limitation
 *   effort    S | M | L
 *   loop      the ANALYSE→EVALUATE→REANALYSE→REEVALUATE→DECIDE artifact.
 *             `attacked` is mandatory for anything marked done: a step with no
 *             output cannot be checked, not even by its author.
 *   result    what was actually produced, once closed
 */
export const SECTIONS = {
  A: 'Automated coverage gaps',
  B: 'Never verified',
  C: 'Product gaps',
  D: 'Housekeeping',
  E: 'Reviewed after challenge',
};

export const ITEMS = [
  {
    id: 1,
    section: 'A',
    effort: 'S',
    status: 'done',
    title: '`removeSessionDir()` has no test, so it cannot be registered as a guard',
    evidence:
      'VERIFIED — test/session-cleanup.test.ts, and the containment check is a proven guard',
    loop: {
      attacked:
        "The obvious test — 'it deletes the directory' — would have passed with the safety check removed, so it measures the wrong half. The interesting behaviour is the REFUSAL: removeSessionDir builds a delete path from a session id supplied from outside, then rm -rf's it. Attacked it with traversing ids ('..', '../../..', '../../../auth.json') and asserted a canary OUTSIDE the session store survives. Verified load-bearing: disabling the containment line makes the test fail.",
    },
    result:
      'Exported removeSessionDir and covered three behaviours: it removes the throwaway session doctor creates, it REFUSES ids that escape the store (canary survives), and a missing session is a no-op rather than a throw — doctor calls it best-effort and tidying up must never fail the diagnostic. Guard session-cleanup-stays-in-the-store proven.',
  },
  {
    id: 2,
    section: 'A',
    effort: 'S',
    status: 'done',
    title: "Terminal client's exit guard (`nothing to drive from here`) has no test",
    evidence:
      'VERIFIED — test/term-exit.test.ts drives the real CLI against a real daemon over a real socket',
    loop: {
      attacked:
        "My first test hung, and my SECOND detector was also wrong — twice on one item. (1) `assert.equal(e.killed, false || undefined)` evaluates to `=== undefined`, so a clean non-zero exit, where killed is false, reported a hang that never happened. (2) Once fixed it exited 1 but printed 'no session matching does-not-exist' — a CLIENT-SIDE pre-check, not the guard. The guard fires on a daemon ERROR frame arriving before any session exists. A valid token can never reach it, so the test now uses a token the daemon REJECTS. Without that, the file would have gone green while the control stayed untested.",
    },
    result:
      'The client exits non-zero and prints "no session opened — nothing to drive from here" instead of sitting with no prompt and no way to quit but ctrl-C (originally exit 124, killed by timeout). Guard term-exits-when-no-session-opened proven load-bearing.',
  },
  {
    id: 3,
    section: 'A',
    effort: 'L',
    status: 'open',
    title: 'Mock debt: 13 of 32 test files reference a mock/stub/fake',
    evidence: 'VERIFIED — directive-check.mjs reports it as DEBT under 03 law 4',
  },
  {
    id: 4,
    section: 'A',
    effort: 'S',
    status: 'done',
    title: 'Real agents spawned outside `npm test` still write into the developer’s ~/.grok',
    evidence:
      'VERIFIED — check:stranger runs leak-free (20 -> 20 sessions); the residual groups came from running test files DIRECTLY, which the wrapper never covered',
    loop: {
      attacked:
        'Attacked my own fix: the isolated-test wrapper was assumed to cover the leak, so I measured check:stranger and it was clean — 20 sessions before and after. The leak was still recurring, which REFUTED "the wrapper is enough". Tracing the new group (grokrc-leadertest-Y6ANl9) showed it came from `node --test test/leader.test.ts` run directly while debugging: the wrapper only applies through npm scripts, and debugging never goes through them.',
    },
    result:
      'leader.test.ts now refuses to spawn a real agent when GROK_HOME is unset or is the real home, and skips with a message naming the fix. Verified: running the file directly leaves the session count unchanged (20 -> 20), while `npm test` still exercises the leader for real (206/206, 0 skipped).',
  },
  {
    id: 20,
    section: 'A',
    effort: 'M',
    status: 'done',
    title: 'CI had been failing on EVERY run since 2026-08-06 and nobody looked',
    evidence:
      'VERIFIED — gh run list showed 10 consecutive failures across the public launch and two npm releases',
    loop: {
      analyse:
        'gh run list: every run back to 2026-08-06 red. Two distinct causes — test/leader.test.ts crashing the runner with `spawn grok ENOENT`, and four protocol-hardening tests timing out.',
      evaluate:
        'Candidates: (a) CI-only infrastructure flake, (b) tests genuinely need a real agent, (c) a defect in the tests themselves. The claim in CONTRIBUTING and ci.yml — "tests that need grok skip themselves, so CI stays green" — was itself a candidate, and it was FALSE.',
      attacked:
        'Attacked "CI-only flake" by reproducing the CI environment locally: PATH stripped of grok, full suite. It reproduced immediately — 3 failures — so flakiness was REFUTED and the failures were real. Then attacked my own fixes the same way after every change, which caught three regressions I introduced (a missed call site, an out-of-scope watcher, and a regex whose [^)]* could not span connect(clientUrl())). Also attacked the assumption that a passing test proves coverage: test/onboarding silently RETURNED without an agent, and a skipped test counts as a pass, which is why the doctor-login guard reported "passes without the control" on CI while passing locally.',
      survived:
        'Three real defects: spawn() emits ENOENT asynchronously so a try/catch could never catch it (the twin of the AcpClient unhandled-error bug); tests COUNTED websocket frames when the daemon broadcasts `sessions` on any list change; and watchers were attached AFTER send(), so a fast reply was dropped rather than queued.',
      decide:
        'One shared test/helpers/ws.ts with watch(), buffering from socket open and matching on content — replacing three private copies. Spawn error listeners in leader/takeover. relay.test.ts scripted so it no longer needs an agent it never tested. authHint() extracted as a pure function so its guard is provable without grok.',
    },
    result:
      'CI environment reproduced locally (no agent on PATH): 201 pass, 0 fail, 3 skipped, exit 0. Developer environment: 204/204, both real-stack checks ALL CLEAR. Guards 15/15 in the CI environment, where one was previously unprovable.',
  },
  {
    id: 21,
    section: 'A',
    effort: 'S',
    status: 'done',
    title: 'Real-stack checks load dist/ but nothing warned when it was stale',
    evidence:
      'VERIFIED — six consecutive false "still failing" results on #19 were the harness testing the previous build',
    loop: {
      attacked:
        'Directive 11: the same signature five or more times is mechanism debt, not bad luck. I had blamed the product, then my assertions, then the event shapes — three wrong diagnoses in a row — before instrumenting and finding that my code was never executing. The recurring signature was "edit src/, run a real-stack check, observe no change". Attacked the idea that a comment or a habit would prevent it: both are HONOR-tier, and HONOR is what had just failed six times running.',
      survived:
        'bootDaemon() now compares the newest mtime in src/ against dist/ and THROWS rather than testing a stale build.',
    },
    result:
      'PRE-FIX: `touch src/daemon/session-manager.ts` then run a check -> it ran happily against the old build. POST-FIX: "dist/ is 661s older than src/ — you are about to test the PREVIOUS build." After `npm run build` it proceeds and the check is ALL CLEAR.',
  },
  {
    id: 5,
    section: 'B',
    effort: 'S',
    status: 'done',
    title: 'Node 20 and 21 untested; `engines` claims >=20',
    evidence: 'VERIFIED — CI matrix: dist on Node 20, 21, 22 and 24, ubuntu and macos, 8/8 green',
    loop: {
      attacked:
        'Attacked the obvious matrix design first: `node-version: [20, 22]` running `npm test` would FAIL on 20, because the suite uses --experimental-strip-types which does not exist before 22.6 — measuring the test framework, not the product. REFUTED. Also attacked omitting Node 21 as "short-lived": that is a reason to expect it works, not evidence, and `engines` admits it, so it is tested.',
    },
    result:
      'compat.yml builds once on 22 then EXECUTES dist/ on 20, 21, 22, 24: --help, the engines floor, doctor failing cleanly, config naming defaultCwd, and up refusing without an agent. All 8 runtime jobs green.',
  },
  {
    id: 6,
    section: 'B',
    effort: 'S',
    status: 'done',
    title: 'macOS untested; README says "expected to work"',
    evidence:
      'VERIFIED — the same matrix on macos-latest: 4 runtime jobs plus 2 full-suite jobs green',
    loop: {
      attacked:
        'Attacked "macOS is basically Linux for a Node CLI" — untested is untested, and the systemd unit is genuinely Linux-only. Ran the real suite there rather than reasoning about it. What SURVIVED: the package and the full suite both work on macOS; only the systemd unit does not, which the docs already say.',
    },
    result:
      'macos-latest covered for dist on all four Node versions AND the full suite on 22 and 24. README no longer says "expected to work".',
  },
  {
    id: 7,
    section: 'B',
    effort: 'M',
    status: 'open',
    title: 'Relay mode never run against a real VPS',
    evidence: 'UNVERIFIED — covered in-process and in a browser, never over the internet',
  },
  {
    id: 8,
    section: 'B',
    effort: 'M',
    status: 'open',
    title: 'Android push never tested',
    evidence: 'UNKNOWN — no Android device available',
  },
  {
    id: 9,
    section: 'B',
    effort: 'M',
    status: 'open',
    title: 'Multi-file diff rendering and very long tool output unverified',
    evidence: 'UNVERIFIED — browser tests replay captured write/edit payloads only',
  },
  {
    id: 10,
    section: 'C',
    effort: 'M',
    status: 'done',
    title: '`grokrc doctor` spawns its own probe agent instead of asking the running daemon',
    evidence:
      'VERIFIED — doctor reported "0 sent" while the daemon had delivered two; it now reports the daemon\'s live counters',
    loop: {
      attacked:
        'Attacked the item as written — "doctor spawns its own probe" — and REFUTED it as the thing that matters. Removing the self-probe would break the most common case: a new user runs `grokrc doctor` BEFORE `grokrc up`, with no daemon to ask. What survived was a sharper defect underneath: doctor loads its own PushService from disk, and delivery counters (sent/failed/expired) live only in the daemon\'s memory. Measured it rather than reasoned about it — the daemon had delivered two pushes and doctor printed "0 sent, 0 failed, 0 expired". Then attacked my own first fix twice: it printed the push line TWICE (live and disk), and it sat AFTER the missing-agent early return, so a box without grok never saw the daemon report at all — which also made it untestable on CI, where the test initially failed for exactly that reason.',
    },
    result:
      'doctor now asks the control socket FIRST, before even the agent check, and reports pid, address, live sessions, connected/paired devices and real delivery counters. The disk fallback runs only when no daemon answers and says so explicitly. test/doctor-daemon.test.ts drives the real CLI against a control socket reporting 41 sent — a number no disk-reading process could invent — and asserts the disk fallback did NOT run. Guard doctor-asks-the-running-daemon proven load-bearing.',
  },
  {
    id: 22,
    section: 'C',
    effort: 'M',
    status: 'done',
    title: 'Opening a long session crashed the phone — "A problem repeatedly occurred"',
    evidence:
      "VERIFIED — the owner's x.com session is 1518 events / 9.97 MB; a real browser received 4.5 MB and rendered 1.6 million characters",
    loop: {
      attacked:
        'The reported symptom was "clicking a notification crashes the page", so the notification path was the obvious suspect. Measured instead of assumed: the screenshot URL was /?session=..., the COLD-LAUNCH openWindow path — and grep shows app.js never reads that query param, so the deep link is dead code and could not be the crash. What survived was size: historyLimit caps how many SESSIONS are listed and NOTHING capped the events sent for one. Then attacked my own first fix — a per-event cap on `.text` — which changed the measured payload by EXACTLY NOTHING, because the bulk lives in tool_call_update at content[].newText, rawOutput and _meta.details. Only walking the whole event moved the number.',
    },
    result:
      'Two caps in server.ts: the last 300 events, with a marker naming how many were dropped, and a 4000-character ceiling on any string anywhere in an event. Measured on the real transcript: 9.97 MB -> 2.16 MB -> 1.65 MB, a 6x reduction; in a real browser 4.5 MB -> 0.7 MB, DOM nodes 1446 -> 242.',
  },
  {
    id: 23,
    section: 'A',
    effort: 'S',
    status: 'done',
    title: 'A real-stack check reported 3 problems while `npm test` exited 0',
    evidence:
      'VERIFIED — midturn-check printed "3 PROBLEM(S)" and the suite passed; forcing a failure now exits 1',
    loop: {
      attacked:
        'reporter().finish() RETURNS an exit code, and three of the four tools do `const code = finish()`. The one I wrote discarded it, so that check could never fail the build — a gate certifying nothing, which is the same class of defect this sweep keeps surfacing. Attacked the narrow fix (use the return value in that one tool) as insufficient: it leaves the trap armed for the next tool, and HONOR is exactly what had just failed. Also checked the other three rather than assuming — they were correct, so this was not a widespread twin.',
    },
    result:
      'finish() now sets process.exitCode as well as returning it, so a caller who drops the value still fails the build. Proven on known-bad input per directive 03: forcing a failure in midturn-check exits 1, where it previously exited 0.',
  },
  {
    id: 24,
    section: 'A',
    effort: 'S',
    status: 'done',
    title: 'A fix can sit on disk while the daemon keeps running the old code',
    evidence:
      'VERIFIED — dist/server.js was built at 12:37:32; the daemon had started at 12:31:57 and was still serving the pre-fix code when the owner was told it was live',
    loop: {
      attacked:
        'The owner said the crash was not fixed. My first candidate was my own fix being wrong, and the second was their phone caching an old bundle — I had told them to reload. Both REFUTED by comparing two timestamps: the daemon started six minutes BEFORE the build it was supposed to be running. The code was correct and had simply never been loaded. This is the deployment-side twin of #21, where the test harness read a stale dist/; I fixed the test path and did not look at the deploy path.',
    },
    result:
      'The watchdog now compares dist/daemon/server.js mtime against the daemon start time and restarts when the build is newer. Proven: touch dist -> run watchdog -> pid 1617626 becomes 1617847, logged as "reloaded the current build". After the reload the crash fix measured 4.5 MB -> 0.50 MB, 2000 -> 301 events, 1,624,434 -> 218,000 characters rendered.',
  },
  {
    id: 11,
    section: 'C',
    effort: 'M',
    status: 'open',
    title: '`grokrc config set` requires a daemon restart to take effect',
    evidence: 'VERIFIED — src/cli.ts prints "restart to apply"',
  },
  {
    id: 12,
    section: 'C',
    effort: 'S',
    status: 'open',
    title: 'Android home-screen / notification docs are thin',
    evidence: 'VERIFIED — USER-GUIDE §10 covers iOS in depth, Android in two lines',
  },
  {
    id: 13,
    section: 'D',
    effort: 'S',
    status: 'done',
    title: '/tmp/grokrc-handback and its throwaway session in ~/.grok',
    evidence: 'VERIFIED — directory removed',
    loop: {
      attacked:
        'Checked first whether anything still referenced it: the ~/.grok session pointing at it was in the dead-cwd set being cleared in the same pass, so removing the directory orphaned nothing.',
    },
    result: '/tmp/grokrc-handback removed along with its session group.',
  },
  {
    id: 14,
    section: 'D',
    effort: 'S',
    status: 'open',
    title: 'Two pre-launch backup bundles in $HOME, 8.6 MB',
    evidence: 'VERIFIED — grokrc-pre-*.bundle',
  },
  {
    id: 15,
    section: 'D',
    effort: 'S',
    status: 'done',
    title: '3 dead-cwd session groups in ~/.grok (residue of #4)',
    evidence: 'VERIFIED — 4 dead-cwd groups removed; a fresh scan finds none',
    loop: {
      attacked:
        'Attacked the idea that clearing them was sufficient: the same residue had already been cleared once and came back, so deleting without closing the source would just repeat. Held this until #4 was actually fixed, then cleared.',
    },
    result:
      '4 groups removed (grokrc-pkgtest-DXc5, grokrc-leadertest-gkXRVV, grokrc-leadertest-Y6ANl9, grokrc-public-uNy4). Session count stable at 15 across a subsequent full run.',
  },
  {
    id: 16,
    section: 'E',
    effort: 'M',
    status: 'open',
    title: 'A malicious relay can serve modified JavaScript',
    evidence:
      'VERIFIED — the relay serves the PWA (src/relay/server.ts). Installing the client from the daemon’s origin removes the attack',
  },
  {
    id: 17,
    section: 'E',
    effort: 'M',
    status: 'accepted',
    title: 'A relay sees routing metadata — sizes, timing, endpoints',
    evidence:
      'Inherent: a relay cannot route what it cannot see. Sizes could be padded; routes and timing cannot be hidden without cover traffic',
  },
  {
    id: 18,
    section: 'E',
    effort: 'S',
    status: 'not-a-limitation',
    title: 'Observed mode is read-only while mirroring',
    evidence:
      'Correct architecture — no ACP channel to an agent the daemon did not spawn. Take over closes it and is verified on a real TUI',
  },
  {
    id: 19,
    section: 'E',
    effort: 'M',
    status: 'done',
    title: 'A turn killed mid-flight may lose its tail; recovery on resume is unverified',
    evidence:
      'UNVERIFIED — no test covers it, and Take over kills the agent mid-turn BY DESIGN, so this is on the main path',
    loop: {
      attacked:
        'Attacked the README\'s own explanation first — "Grok may not have flushed its last message; resuming replays from the agent and recovers it". BOTH halves were REFUTED. The tail was lost in OUR code: streaming text is coalesced in s.stream and only reaches s.log when the stream ENDS, so closing mid-turn dropped a buffer the user had already watched fill; and resume recovered nothing because there was nothing left to recover. Then attacked my own harness four separate times, each of which had produced a confident wrong answer: it counted the USER\'s echoed prompt as agent output so the kill landed before the agent spoke; it filtered history on the wrong event kinds; it read history() after close and mistook the observed-log fallback for evidence; and — six consecutive false "still failing" runs — bootDaemon loads dist/ while I was editing src/, so every result described the PREVIOUS build. Only instrumenting #retainLog and #recoverLostTail exposed that: NEITHER line printed, which is impossible if the code had run at all. Finally attacked the first version of the regression test, which passed with the control disabled because a replaying mock cannot express "the agent never persisted this".',
      survived:
        'Flush the coalesced stream before close() retains it; keep the witnessed log bounded (400 events x 8 sessions); on resume, put back ONLY what loadSession did not replay, since duplicating a transcript is worse than losing its tail.',
    },
    result:
      'Real agent, tools/midturn-check.mjs — PRE-FIX: streamed "1..22", resumed history 0 chars. POST-FIX: "recovered 2 event(s) the agent never persisted", resumed history 71 chars, last streamed line survived, ALL CLEAR. Now part of test:real. test/midturn.test.ts drives an agent whose session/load replays NOTHING, so retention is the only path by which the text can return; guard flush-before-retain is proven load-bearing.',
  },
];
