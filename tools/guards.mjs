/**
 * The load-bearing controls, and the test that must notice when each is gone.
 *
 * DATA ONLY. The runner is tools/verify-guards.mjs — one implementation over
 * this list, never a script per guard.
 *
 * Every entry here was verified by hand once, and the proof was written into a
 * commit message. Prose does not re-run. This file exists so `npm run
 * verify:guards` re-proves all of it: disable the control, and the named test
 * MUST fail. A test that still passes with its control removed is measuring
 * nothing, however green it looks.
 *
 * Fields
 *   id       stable slug, shown in the report
 *   why      what breaks in the product if this control is lost
 *   file     source file to mutate
 *   find     exact text to replace — MUST occur `count` times, or the entry is
 *            reported as drift rather than silently skipped
 *   replace  the disabled form
 *   count    expected occurrences (default 1)
 *   test     the test file that must fail once the control is disabled
 *   onlyOn   'win32' | 'posix' — the platform where this control is REACHABLE.
 *            Elsewhere the runner reports it as unprovable rather than unproven:
 *            a control whose code path the current OS never executes cannot be
 *            shown to be load-bearing here, and calling that a failure makes CI
 *            red for the operating system it is running on rather than for a
 *            defect. Prose in `why` cannot be enforced; this field can.
 */
export const GUARDS = [
  {
    id: 'path-containment-refuses-escapes',
    why: 'four call sites (static serving in the daemon and the relay, the observed-session store, and doctor’s cleanup) ask "is this path inside that root?" through this one function. Without the refusal it answers yes to everything, and the two HTTP guards become directory traversal',
    file: 'src/paths.ts',
    find: "  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return false;",
    replace: '',
    test: 'test/paths.test.ts',
  },
  {
    id: 'takeover-identity-matches-the-platform-shape',
    onlyOn: 'win32',
    why: 'processArgs returns a command line on POSIX and an executable path on Windows. Matching a path with the command-line predicate word-splits it, so `C:\\Program Files\\grok\\grok.exe` reduces to `C:\\Program` and a genuine agent is refused — takeover is dead in Grok’s own default install location. WINDOWS-ONLY: on POSIX both branches are the same call, so verify-guards reports this unproven there rather than failing',
    file: 'src/daemon/session-manager.ts',
    find: '    const identifiesAsGrok = IS_WINDOWS ? looksLikeGrokExe(args) : looksLikeGrok(args);',
    replace: '    const identifiesAsGrok = looksLikeGrok(args);',
    test: 'test/takeover.test.ts',
  },
  {
    id: 'config-dir-drops-inherited-access',
    onlyOn: 'win32',
    why: '~/.grokrc holds the VAPID private key, the device store and a plaintext `grokrc term` token. POSIX gets 0700; on Windows the mode is ignored, so an ACL replaces it. `/inheritance:r` is the load-bearing half — a bare /grant is ADDITIVE, so an inherited Users or Everyone entry would survive and the directory would be no more private than its parent. WINDOWS-ONLY: on POSIX this argument list is never reached',
    file: 'src/daemon/config-dir.ts',
    find: "      [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/Q'],",
    replace: "      [dir, '/grant', `${user}:(OI)(CI)F`, '/Q'],",
    test: 'test/config-dir.test.ts',
  },
  {
    id: 'exposure-notice-tells-the-truth',
    why: 'the one line saying who can reach the daemon is safety text for a remote-code-execution surface. It used to branch only on 0.0.0.0, so binding to a Tailscale address announced "loopback only" while every machine on the tailnet could drive a session — understating exposure, which is the direction that matters',
    file: 'src/cli.ts',
    find: '  if (!LOOPBACK_HOSTS.has(host)) {',
    replace: '  if (false) {',
    test: 'test/exposure-notice.test.ts',
  },
  {
    id: 'push-prompt-always-renders',
    why: 'iOS Safari tabs have no PushManager; the early return left users with no row and no reason',
    file: 'web/app.js',
    find: "  // Push already works — nothing to say.\n  if (pushPermission() === 'granted') return;",
    replace:
      "  if (!('PushManager' in window)) return;\n  // Push already works — nothing to say.\n  if (pushPermission() === 'granted') return;",
    test: 'test/push-prompt.test.ts',
  },
  {
    id: 'push-row-is-not-a-session',
    why: '`.session` must mean a session; when this row wore it, click(".session") opened a notification prompt',
    file: 'web/app.js',
    find: "  row.className = 'notice';",
    replace: "  row.className = 'session';",
    test: 'test/push-prompt.test.ts',
  },
  {
    id: 'handback-survives-transcript-render',
    why: 'history replay wipes the session view; without the re-render there is no way to return a session to a terminal',
    file: 'web/app.js',
    find: '  else if (state.current) renderHandBackBar(state.current);',
    replace: '',
    test: 'test/handback.test.ts',
  },
  {
    id: 'vapid-subject-is-routable',
    why: 'Apple 403s a VAPID subject it cannot route; the shipped default mailto:grokrc@localhost broke push on every iPhone while Firefox kept working',
    file: 'src/daemon/push.ts',
    find: '    if (!isRoutableSubject(this.#keys.subject)) {',
    replace: '    if (false) {',
    test: 'test/vapid-subject.test.ts',
  },
  {
    id: 'pairing-codes-do-not-cancel-each-other',
    why: 'a single pending slot meant issuing a code destroyed the one being typed — hand over a code, hear "invalid", issue another, and the next attempt fails for that reason. It cost the owner an hour and 29 half-finished pairings',
    file: 'src/daemon/auth.ts',
    find: '    this.#pending.set(code, expiresAt);',
    replace: '    this.#pending.clear();\n    this.#pending.set(code, expiresAt);',
    test: 'test/pairing-codes.test.ts',
  },
  {
    id: 'doctor-asks-the-running-daemon',
    why: 'push delivery counters live in the daemon and are never written to disk, so doctor reading the store reports "0 sent" no matter what was delivered — the answer a user gets when asking whether push works',
    file: 'src/cli.ts',
    find: '  const daemonAnswered = await reportDaemon();',
    replace: '  const daemonAnswered = false;',
    test: 'test/doctor-daemon.test.ts',
  },
  {
    id: 'term-exits-when-no-session-opened',
    why: 'an error before any session leaves the terminal client with no prompt, no way to type and no way to quit but ctrl-C — originally observed as exit 124, killed by timeout',
    file: 'src/term/client.ts',
    find: '        if (!this.#current) {',
    replace: '        if (false) {',
    test: 'test/term-exit.test.ts',
  },
  {
    id: 'session-cleanup-stays-in-the-store',
    why: 'removeSessionDir builds a delete path from a session id supplied from outside; without the containment check a diagnostic command becomes an arbitrary recursive delete',
    file: 'src/cli.ts',
    find: "    if (!isStrictlyInside(resolve(grokHome, 'sessions'), dir)) return;",
    replace: '    // containment check disabled',
    test: 'test/session-cleanup.test.ts',
  },
  {
    id: 'flush-before-retain',
    why: 'streaming text lives in s.stream until the stream ends; without flushing at close(), a turn stopped mid-flight loses the tail the user already watched arrive — and Take over stops turns mid-flight by design',
    file: 'src/daemon/session-manager.ts',
    find: '    this.#flush(s);\n    this.#retainLog(id, s.log);',
    replace: '    this.#retainLog(id, s.log);',
    test: 'test/midturn.test.ts',
  },
  {
    id: 'health-reports-real-version',
    why: 'the version was hardcoded twice and reported 0.1.0 from a 0.1.1 build — the first thing anyone checks when a fix looks missing',
    file: 'src/daemon/server.ts',
    find: "        if (v.name === 'grokrc' && v.version) return (PKG_VERSION = v.version);",
    replace: "        if (v.name === 'grokrc' && v.version) return (PKG_VERSION = '0.1.0');",
    test: 'test/asset-version.test.ts',
  },
  {
    id: 'up-refuses-without-agent',
    why: 'grokrc up used to start with no agent installed, so a new user paired a phone to a daemon that could not open a session',
    file: 'src/cli.ts',
    // Anchored on the trailing context, because cmdDoctor has an identical
    // `if (!grokVersion)` shape — the drift check caught that ambiguity.
    find: '    process.exitCode = 1;\n    return;\n  }\n\n  // Settings are the durable answer',
    replace: '  }\n\n  // Settings are the durable answer',
    test: 'test/onboarding.test.ts',
  },
  {
    id: 'doctor-names-the-login-command',
    why: "a logged-out user got the agent's raw 'Authentication required (-32000)', which names no command",
    file: 'src/cli.ts',
    // Anchored on the PURE function, so the guard is provable on a machine with
    // no agent. The previous anchor sat in cmdDoctor, whose only test skipped
    // itself without grok — and a skipped test counts as a pass, so the guard
    // reported "passes without the control" on every CI run.
    find: '  if (!/auth|unauthori[sz]ed|not logged in|-32000/i.test(message)) return null;',
    replace: '  if (true) return null;',
    test: 'test/onboarding.test.ts',
  },
  {
    id: 'busy-not-derived-from-history',
    why: 'a turn killed mid-flight leaves a `working` status in the log; replaying it pinned the composer to Stop and no message could be sent',
    file: 'web/app.js',
    find: '      if (!replaying) {\n        setBusy(',
    replace: '      if (true) {\n        setBusy(',
    test: 'test/busy-state.test.ts',
  },
  {
    id: 'takeover-pid-identity',
    why: 'pids get recycled; without the argv[0] check a stale registry entry makes a phone tap kill an unrelated process',
    file: 'src/daemon/session-manager.ts',
    find: '    if (!identifiesAsGrok) {',
    replace: '    if (false) {',
    test: 'test/takeover.test.ts',
  },
  {
    id: 'cwd-must-exist',
    why: 'a deleted working directory spawns as ENOENT and used to be reported as a missing grok binary',
    file: 'src/daemon/session-manager.ts',
    find: '    await assertCwdExists(cwd);\n',
    replace: '',
    count: 2, // create() and resume() — the twin
    test: 'test/spawn-failure.test.ts',
  },
  {
    id: 'spawn-error-is-not-fatal',
    why: "an 'error' event with no listener is thrown by Node, so one unspawnable session killed the whole daemon",
    file: 'src/acp/client.ts',
    find: "    this.#transport.on('error', (e) => {",
    replace:
      "    this.#transport.on('error', (e) => this.emit('error', e));\n    const __unused = ((e) => {",
    test: 'test/spawn-failure.test.ts',
  },
  {
    id: 'harness-refuses-real-grok-home',
    why: 'tests spawning a real agent wrote 80 sessions into the developer’s own ~/.grok',
    file: 'tools/harness.mjs',
    find: '  if (!transportFactory) {',
    replace: '  if (false) {',
    test: 'test/harness-isolation.test.ts',
  },
  {
    id: 'ndjson-line-ceiling',
    why: 'an unterminated ACP line would grow until the daemon ran out of memory',
    file: 'src/acp/transport.ts',
    find: 'const MAX_LINE_BYTES = 8 * 1024 * 1024;',
    replace: 'const MAX_LINE_BYTES = Number.MAX_SAFE_INTEGER;',
    test: 'test/transport-resilience.test.ts',
  },
  {
    id: 'stdin-error-handler',
    why: 'an unhandled EPIPE on the agent’s stdin took down the entire daemon. POSIX-ONLY PROOF: the control is detected by the process CRASHING on an unhandled stream error, which needs a write to land in flight. Measured on Windows — 40/40 sends took the `stdin.writable === false` path in send() and stdin.write was never reached, so no EPIPE, no error event, and verify-guards reports this UNPROVEN there. The control still matters: the daemon runs on Linux under systemd',
    file: 'src/acp/transport.ts',
    find: "    this.#child.stdin.on('error', (err: NodeJS.ErrnoException) => {",
    replace: "    this.#child.stdin.on('__disabled', (err: NodeJS.ErrnoException) => {",
    test: 'test/transport-resilience.test.ts',
  },
  {
    id: 'relay-room-ownership',
    why: 'without it one tenant answers another tenant’s /api/pair with a forged token',
    file: 'src/relay/server.ts',
    find: '        if (pending.roomId !== room.id) return;',
    replace: '',
    test: 'test/relay-isolation.test.ts',
  },
  {
    id: 'config-reload-reaches-the-daemon',
    why: 'without it `config set` writes the file and the running daemon keeps the old value, while the CLI says it applied — the worst of both, since the user has no reason to restart',
    file: 'src/daemon/config.ts',
    find: '    targets.server.applyConfig({ historyLimit: next.historyLimit });',
    replace: '',
    test: 'test/config-reload.test.ts',
  },
  {
    id: 'config-reload-admits-what-it-cannot-apply',
    why: 'host/port/lan are bound at listen(); reporting them as applied is a lie that only surfaces later, when the daemon is still on the old port',
    file: 'src/daemon/config.ts',
    find: '    if (JSON.stringify(next[k]) !== JSON.stringify(boot[k])) needsRestart.push(k);',
    replace: '',
    test: 'test/config-reload.test.ts',
  },
  {
    id: 'tool-row-keeps-the-filename',
    why: 'grok’s completion event carries no title and no kind, so the normalizer falls back to the literal word “tool”. Written straight over the label it erased the filename, and a three-file edit finished as three identical rows saying “tool”.',
    file: 'web/app.js',
    find:
      '  const label = toolLabel(ev, node.dataset.label, Number(node.dataset.rank ?? 0));\n' +
      '  node.dataset.label = label.text;\n' +
      '  node.dataset.rank = String(label.rank);\n' +
      "  node.querySelector('.nm').textContent = label.text;",
    replace: "  node.querySelector('.nm').textContent = ev.title || ev.name;",
    test: 'test/browser.test.ts',
  },
  {
    id: 'request-bodies-decode-once',
    why: 'accumulating a body with `raw += chunk` decodes each Buffer separately, so a multi-byte UTF-8 character split across a TCP boundary becomes U+FFFD. Measured: pairing "Sandeep’s iPhone" stored "Sandeep???s iPhone". TCP picks the boundary, so nothing the caller does prevents it.',
    file: 'src/http-body.ts',
    find: "  return Buffer.concat(chunks).toString('utf8');",
    replace: "  return chunks.map((c) => c.toString()).join('');",
    test: 'test/body-encoding.test.ts',
  },
  {
    id: 'relay-can-refuse-to-serve-the-client',
    why: 'a relay that serves the PWA owns the session — the page’s JavaScript is what decrypts, so a modified client reads everything before encryption applies. No in-page integrity check helps: attacker-supplied code cannot verify itself, and the relay serves index.html too.',
    file: 'src/relay/server.ts',
    find: '    if (!this.#serveClient) {',
    replace: '    if (false) {',
    test: 'test/relay-transport-only.test.ts',
  },
  {
    id: 'live-events-are-capped',
    why: 'trimEvent was wired into history only. A live tool_call_update carrying a whole file went to the phone whole — the crash the owner hit happened while READING a session, not opening one.',
    file: 'src/daemon/server.ts',
    find: '      const payload = trimEvent(ev);',
    replace: '      const payload = ev;',
    test: 'test/live-event-size.test.ts',
  },
  {
    id: 'turn-completion-is-understood',
    why: 'lose this case and every session sits on “working” forever — the phone never shows a finished turn. Thirteen test files drive a mock that always sends `turn_completed`, so they would stay green while the real agent’s completion signal fell through to an opaque `raw` passthrough.',
    file: 'src/daemon/events.ts',
    find: "    case 'turn_completed':",
    replace: "    case '__disabled_turn_completed':",
    // Not a node:test file: this one drives a REAL grok and compares it against
    // the pinned protocol surface. That is the point — it is the only check in
    // this repo that can notice the live agent and the mock parting ways.
    test: 'tools/acp-conformance.mjs',
  },
];
