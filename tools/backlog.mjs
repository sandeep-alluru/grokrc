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
    status: 'open',
    title: '`removeSessionDir()` has no test, so it cannot be registered as a guard',
    evidence: 'VERIFIED — src/cli.ts defines it; grep over test/ returns nothing',
  },
  {
    id: 2,
    section: 'A',
    effort: 'S',
    status: 'open',
    title: "Terminal client's exit guard (`nothing to drive from here`) has no test",
    evidence: 'VERIFIED — src/term/client.ts has it, no test references it',
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
    status: 'open',
    title: 'Real agents spawned outside `npm test` still write into the developer’s ~/.grok',
    evidence:
      'VERIFIED — 3 dead-cwd groups reappeared: grokrc-pkgtest-*, grokrc-leadertest-*, grokrc-public-*',
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
    id: 5,
    section: 'B',
    effort: 'S',
    status: 'open',
    title: 'Node 20 and 21 untested; `engines` claims >=20',
    evidence: 'UNVERIFIED — only Node 22 exists here. Settled by a CI matrix',
  },
  {
    id: 6,
    section: 'B',
    effort: 'S',
    status: 'open',
    title: 'macOS untested; README says "expected to work"',
    evidence: 'UNVERIFIED — no macOS machine. Settled by a macos-latest CI job',
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
    status: 'open',
    title: '`grokrc doctor` spawns its own probe agent instead of asking the running daemon',
    evidence: 'VERIFIED — src/cli.ts builds its own StdioTransport',
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
    status: 'open',
    title: '/tmp/grokrc-handback and its throwaway session in ~/.grok',
    evidence: 'VERIFIED — directory present',
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
    status: 'open',
    title: '3 dead-cwd session groups in ~/.grok (residue of #4)',
    evidence: 'VERIFIED — scan of ~/.grok/sessions',
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
    status: 'open',
    title: 'A turn killed mid-flight may lose its tail; recovery on resume is unverified',
    evidence:
      'UNVERIFIED — no test covers it, and Take over kills the agent mid-turn BY DESIGN, so this is on the main path',
  },
];
