# Windows compatibility — handover

**Written:** 2026-08-10, from a Linux workstation. Nothing in this document was
run on Windows by its author. Every claim below is labelled **VERIFIED**,
**UNVERIFIED**, or **UNKNOWN**, and the check that settles each open one is
named. Where you find this document wrong, the document is wrong — trust the
machine in front of you.

> **Updated 2026-08-10, from Windows 11 (Node 24, `grok 1.0.0` native).** The
> suite has now been run here. §2's UNKNOWNs are settled, §3.1's proposed fix
> was MEASURED and is incomplete — see the correction in place — and two defects
> nobody had listed made the product unusable on this platform rather than
> merely degraded. Sections carrying new results say so inline.
>
> One claim in this document was wrong in a way worth naming up front: it said
> the Windows gap was about the control socket and takeover. Those were real,
> but they were not what stopped grokrc working here. **The daemon returned 403
> for every file in its own PWA, and every absolute path on the machine was
> refused as "not absolute".** Both were single-line POSIX assumptions in code
> the Windows CLI smoke tests never executed.

---

## 0. What this project is

**grokrc is a remote control for xAI's Grok Build.** A daemon runs on your
workstation next to the agent; your phone opens a small web app and drives the
same session — reading output, sending prompts, and approving tool calls with
one tap.

The thing that makes it different from every incumbent: it speaks Grok's typed
**ACP** protocol (`grok agent stdio`), not scraped terminal output. Approvals
arrive as real `session/request_permission` objects with real options, so a tap
answers the agent directly. PTY-based tools have to regex ANSI escape codes and
guess when the agent is waiting.

### The shape of it

```
  phone (PWA)  ──WebSocket──>  grokrc daemon  ──ACP over stdio──>  grok agent
                                     │
                                     └── control pipe/socket ──>  grokrc CLI
```

- **daemon** — owns agent processes, normalises their events, serves the PWA and
  a WebSocket, handles pairing and device tokens.
- **PWA** (`web/`) — no build step, plain ESM. Served by the daemon.
- **CLI** (`src/cli.ts`) — `up`, `pair`, `devices`, `revoke`, `config`, `doctor`,
  `term`, `relay`.
- **control channel** — a Unix socket (or a named pipe on Windows) so the CLI can
  talk to the *running* daemon instead of telling you to restart it.

### Code map

| Path | What lives there |
|---|---|
| `src/acp/` | protocol types, the ACP client, stdio/WebSocket transports, the scripted mock agent |
| `src/daemon/` | server, session manager, auth, events, push, config, control channel |
| `src/relay/` | optional public relay for when nothing can listen on your machine |
| `src/term/` | `grokrc term`, the terminal client |
| `web/` | the PWA — `app.js`, `crypto.js`, service worker |
| `tools/` | test harness, real-stack checks, guard runner, backlog generator |
| `test/` | the suite; browser tests drive real Chromium against the real PWA |

### Read these next

- **[README](../README.md)** — why it exists, install, and "How it works".
- **[docs/01-architecture.md](01-architecture.md)** — topology, why ACP rather
  than PTY, the three session modes, and the event model that everything else
  hangs off. **Read this one before changing anything in `src/daemon/`.**
- **[docs/USER-GUIDE.md](USER-GUIDE.md)** — what the product actually does, from
  a user's seat.
- **[docs/SETUP.md](SETUP.md)** — install and first run.
- **[SECURITY.md](../SECURITY.md)** — the threat model, and the Windows-specific
  caveats in §3.4 below.
- **[docs/BACKLOG.md](BACKLOG.md)** — generated from `tools/backlog.mjs`; every
  closed item carries the reasoning artifact that closed it.

## 1. What is already true

**VERIFIED — the packaged CLI loads and behaves on Windows.** GitHub Actions run
`windows-latest` on Node 20, 21, 22 and 24. All four jobs pass (run 31430374778,
16/16 green across the whole matrix). Those jobs cover, on real Windows:

| Step | What it proves |
|---|---|
| `node dist/cli.js --help` | the compiled package loads with no runtime error |
| `engines` check | the declared Node floor is satisfiable |
| `doctor` with no agent | fails cleanly, names the missing agent, no stack trace |
| `config` | reads and prints settings |
| `up` with no agent | refuses to start, and says what is missing |

> **These five steps were all green while the product could not serve a single
> file or open a single session on Windows** (§3.0a, §3.0b). Worth keeping in
> mind when reading any "VERIFIED" in this section: a smoke test that never
> requests an asset cannot notice that every asset 403s. That is the argument
> for the `windows-latest` entry now in the `suite` matrix, not just here.

**VERIFIED — the control socket has a Windows form.** Windows has no Unix domain
sockets; `net` will not bind a filesystem path there. `CONTROL_SOCKET_PATH`
(`src/daemon/control.ts`) is now a named pipe, `\\.\pipe\grokrc-<hash>`, where
the hash derives from `CONFIG_DIR` so two accounts on one machine get different
pipes. `chmod` and the stale-socket `unlink` — neither of which exists for a
pipe — are skipped when `IS_WINDOWS`.

**VERIFIED — a control-socket failure is not fatal.** `src/cli.ts` wraps
`control.listen()` in try/catch and logs `⚠ control socket unavailable`. Even if
the pipe work is wrong, `grokrc up` still serves phones; only `pair`, `devices`,
`revoke` and `config` reload lose their channel to the running daemon.

---

## 2. What is NOT known

> **All three UNKNOWNs below are now settled. Kept with their answers rather
> than deleted, because what they turned out to hide is the point.**

**~~UNKNOWN~~ → VERIFIED — the test suite runs on Windows, and the first run was
catastrophic.** `compat.yml` ran the `suite` job on `[ubuntu-latest,
macos-latest]` only; the Windows jobs ran five CLI smoke steps. This was
correctly called the biggest gap. First real run: **149 passing, 169 failing.**
After the fixes in §3, the same command reports **247 passing, 0 failing, 7
skipped** — every skip naming its reason. `windows-latest` is now in the `suite`
matrix, so this cannot silently regress.

**~~UNKNOWN~~ → VERIFIED — xAI ships a native Windows build.** `x.ai/cli/install.sh`
detects `MINGW*|MSYS*|CYGWIN*` and installs `grok-<version>-windows-x86_64.exe`
to `~/.grok/bin/grok.exe`; its own header documents Git for Windows / MSYS2 as a
supported host. Installed and running here: `grok 1.0.0 (3cd0d0cbce)`. **WSL2 is
not required.** Note the installer does not put itself on PATH on Windows — it
prints the instruction and leaves `%USERPROFILE%\.grok\bin` to you.

**~~UNKNOWN~~ → VERIFIED — the named pipe binds, and the CLI reaches a daemon
over it.** `test/control.test.ts`, `test/config-reload.test.ts` and
`test/doctor-daemon.test.ts` all pass on Windows, the last of which spawns the
REAL CLI as a child and has it find a running daemon through the pipe — the
end-to-end proof §4 step 3 asked for. Three tests in that file are skipped here
and say why: a named pipe has no mode, no stale remnant and no directory entry,
so `chmod`, stale-socket reclamation and unlink-on-close have nothing to observe.

**Caveat on all of the above: nothing requiring authentication has run.** `grok
login` has not been completed on this machine, so `npm run test:real` and
`tools/midturn-check.mjs` — the checks that drive a live agent — remain
UNVERIFIED here, and the three `grok agent leader` tests skip.

---

## 3. Known defects, in priority order

> **The two that mattered most were not on this list.** Both were found by
> running the suite, and both were fail-CLOSED — they refused legitimate work
> rather than allowing anything unsafe, which is the only reason the platform
> was merely unusable instead of dangerous.

### 0a. Every absolute path on the machine was refused — FIXED

`assertSafeCwd` (`src/daemon/session-manager.ts`) and `validateConfig`
(`src/daemon/config.ts`) both tested "is this absolute?" as
`cwd.startsWith('/')`. On Windows every real path is `C:\...`, so **every
directory failed**. `create`, `resume`, `observe` and `takeOver` all call it, so
no session could be created, resumed, mirrored or taken over — and
`grokrc config set defaultCwd C:\code`, the one required setting, was refused as
"must be an absolute path".

Measured before the fix, against `node`'s own answer for the same string:

```
cwd under test        : c:\Agent-Hub\grok-remote-control
node path.isAbsolute  : true
validateConfig issues : [{"key":"defaultCwd","message":"must be an absolute path",...}]
create()              : REJECTED -> cwd must be an absolute path
observe()             : REJECTED -> cwd must be an absolute path
```

Now `path.isAbsolute`, which is the platform's own answer and still refuses a
relative path — and still refuses a Windows drive-RELATIVE path like `C:foo`,
which is not absolute despite the drive letter.

### 0b. The daemon returned 403 for every asset of its own PWA — FIXED

Four guards asked "is this resolved path inside that root?" as
`target.startsWith(root + '/')`. `resolve()` returns `C:\...` on Windows, so the
`'/'` suffix never matched and **the check refused everything**:

| Call site | What it broke |
|---|---|
| `src/daemon/server.ts` | every static file 403'd — the phone app could not load at all |
| `src/relay/server.ts` | the same, for the relay-served client |
| `src/daemon/session-manager.ts` | `observe()` threw "resolved outside the session store" for valid sessions |
| `src/cli.ts` | `removeSessionDir()` returned early, so every `doctor` run leaked a session directory |

Measured before the fix — `GET /`, `/app.js`, `/sw.js` and
`/manifest.webmanifest` each returned `403 {"error":"forbidden"}`. After: `200`
with real byte counts, and seven traversal attempts (`/../package.json`,
`/..%2f…`, `/%2e%2e/…`, `/..\package.json`, …) still refused with no leak.

Now one tested helper, `src/paths.ts`, using `relative()` rather than a
separator-aware `startsWith` — it is also case-insensitive on win32, which a
string compare of `C:\Users` against `c:\users` is not. Guard
`path-containment-refuses-escapes` proves the refusal is load-bearing.

### 1. `looksLikeGrok` cannot read a Windows path containing spaces — FIXED (the fix proposed below was incomplete)

`src/daemon/session-manager.ts` takes argv0 by splitting the command line on
whitespace. `C:\Program Files\grok\grok.exe agent stdio` yields `C:\Program`, so
a genuine agent is rejected as "not a grok process" — and `Program Files` is the
normal install location.

**Do not fix this by pattern-matching the whole string.** `sshd --config
/etc/grok` would then match, and this function exists precisely to stop a phone
tap killing an unrelated process. The fix belongs in the Windows implementation
of `processArgs`, which must return **the executable path alone**:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object -ExpandProperty ExecutablePath
```

~~With a clean path and no arguments, the existing separator handling already
works — `looksLikeGrok('C:\tools\grok.exe')` passes today.~~

> **CORRECTION — measured, and this last paragraph is wrong.** Returning the
> bare path is necessary and **not sufficient**. `looksLikeGrok` word-splits
> *before* it looks at separators, so the clean path
> `C:\Program Files\grok\grok.exe` still reduces to `C:\Program` and a genuine
> agent is still refused. The example in the original text works only because
> `C:\tools\grok.exe` happens to contain no space — which is exactly the case
> the defect is not about.
>
> **What was done.** `processArgs` returns the executable path on Windows (as
> proposed), *and* a second predicate `looksLikeGrokExe` matches a path without
> splitting it. They are kept separate deliberately: one predicate accepting
> both shapes would accept `vim /home/me/grok`. `takeOver` dispatches on
> platform, and guard `takeover-identity-matches-the-platform-shape` proves that
> dispatch load-bearing — with it disabled, the takeover suite fails.
>
> `test/takeover.test.ts` now creates its fake agents in a temp directory whose
> name **contains a space**, so the `Program Files` shape is exercised rather
> than assumed. Windows also has no argv[0] to spoof, so where POSIX uses
> `exec -a`, the Windows path copies a real executable to `grok.exe` and runs
> it — a stronger check, since identity there is a fact about a file rather than
> a string a process chose for itself.

### 2. `processArgs` has no Windows implementation — FIXED

It shells out to `ps -o args= -p <pid>`, which does not exist on Windows.

It no longer lies about that. `ENOENT` (the `ps` binary is missing) now returns
`ARGS_UNKNOWN`, distinct from `null` (ps ran, the pid is gone). `takeOver`
refuses on `ARGS_UNKNOWN` with a message naming the cause.

**This was a real safety bug, not a cosmetic one.** Previously both cases
returned `null`, and `takeOver` reads `null` as *"died between the registry read
and now — nothing to stop"* and resumes **without killing**. On any machine
without `ps`, every takeover would have skipped the safety check and put two
agents on one conversation — the exact thing `resume()` exists to refuse.

~~So on Windows today: **takeover fails safely and loudly.** Implementing §3.1
turns it on.~~

> **Now implemented, and takeover works on Windows.** `processArgs` reads the
> process table through `Get-CimInstance Win32_Process` and still distinguishes
> all three answers — a path, `null` for a pid that is genuinely absent, and
> `ARGS_UNKNOWN` when it could not look. One case the original note did not
> anticipate: a protected process reports an **empty** `ExecutablePath`. That is
> "I could not look", not "it is dead", so it maps to `ARGS_UNKNOWN` and
> takeOver still refuses. The pid is validated as an integer before it reaches
> the WQL filter — it arrives from Grok's on-disk registry, so it is not trusted.
>
> `test/takeover.test.ts` passes here in full, including *"a grok-looking owner
> is stopped with SIGTERM"* — the destructive path, end to end, on Windows.

### 3. No service manager off Linux — FIXED

~~`packaging/` contains only systemd units. There is no Windows equivalent, so
"run it as a service" does not apply. Reasonable options, in rough order of
effort: a Startup-folder shortcut, a Scheduled Task at logon, or NSSM. None has
been tried.~~

> **Done: `packaging/windows/`** — `install.ps1`, `uninstall.ps1`,
> `install-watchdog.ps1`, plus `tools/watchdog.ps1`. A Scheduled Task, chosen to
> match the systemd USER unit's shape: runs as you, needs no administrator,
> starts automatically, restarts on failure. A Windows *Service* was rejected —
> services run as SYSTEM or need a stored password, and a coding agent running
> as SYSTEM is the wrong answer to every question.
>
> Verified on this machine, not just written: installed, daemon served
> `{"ok":true}` over the tailnet, stop/start cycled cleanly, uninstalled.
>
> **Three defects found by running it, all fixed:**
>
> 1. *The task exited 1 with no log.* The action was an inline `-Command`
>    carrying three quoted paths inside one already-quoted argument; Task
>    Scheduler passes that string verbatim and the inner quotes terminate it
>    early. It now writes a generated launcher script and uses `-File`, which
>    needs one level of quoting — and restores the thing that made systemd's
>    `EnvironmentFile` good, a generated file you can open and edit.
>
> 2. *`Stop-ScheduledTask` orphaned the daemon.* systemd puts a service in a
>    cgroup and kills the tree; Task Scheduler terminates only the process it
>    launched, so the `node` child survived holding port 4319. The restart then
>    crash-looped on EADDRINUSE **while `/api/health` kept answering from the
>    orphan** — the task said one thing and the port said another. The launcher
>    now clears its own orphan before binding, scoped by the full entry path so
>    it can only ever match a daemon from this checkout.
>
> 3. *The log was unreadable.* node writes UTF-8; PowerShell redirection decoded
>    it as the OEM code page, rendering the daemon's own exposure warning as
>    `ΓÜá reachable from other machines` — the single line most worth reading.
>
> **Honest differences from systemd**, both in the script header: it starts at
> **logon**, not boot (earlier means storing your password, and losing network
> access under S4U); and Task Scheduler captures no output, so stdout is
> redirected to `%LOCALAPPDATA%\grokrc\grokrc.log` instead of the journal —
> `journalctl -f` becomes `Get-Content <log> -Wait`.

### 4. File permissions are not enforced on Windows — FIXED, security-relevant

`src/daemon/config.ts` writes with `mode: 0o600` and creates `CONFIG_DIR` with
`0o700`. Windows largely ignores POSIX modes. Device tokens are stored hashed
(`test/server.test.ts` asserts the plaintext token never reaches disk), so this
is not a token-disclosure hole, but the config directory is less protected than
on Unix.

> **Done.** Five call sites asked for `mode: 0o700` independently; they now
> funnel through `ensureConfigDir()` in `src/daemon/config-dir.ts`, which keeps
> the POSIX mode and, on Windows, applies an ACL with `icacls /inheritance:r`
> followed by a single grant to the current account. At most one `icacls` per
> process — the result is cached, because turning five `mkdir` calls into five
> subprocess spawns would be a poor trade.
>
> Worth noting what the directory actually holds, since the original text
> undersells it: `vapid.json` is a Web Push **private key**, and `term-token` is
> a **plaintext** bearer token for `grokrc term`. Hashed device tokens were not
> the whole story.
>
> **The first version of the test was worthless and verify-guards caught it.**
> It asserted "BUILTIN\Users is absent" on a plain `%TEMP%` directory — which
> has no such entry to begin with, so it passed with the hardening disabled. The
> test now CREATES the condition: it gives a parent an inheritable grant to
> `BUILTIN\Users` (matched by SID, so it does not depend on display language),
> creates the config directory inside it, and requires that the child does not
> keep what it inherited. Guard `config-dir-drops-inherited-access` is proven
> load-bearing against that version.
>
> `/inheritance:r` is the load-bearing half: a bare `/grant` is ADDITIVE, so
> without it an inherited entry survives and the directory is no more private
> than its parent.

Related and already documented in `SECURITY.md`: Windows named pipes are
machine-global and Node exposes no ACL control, so the control pipe's name is
*unguessable* rather than *protected*. On Unix the socket is `chmod 0600` in the
user's own directory.

### 4b. Line endings defeat two of this repo's own mechanisms — PARTLY FIXED

Not a product defect, and the reason a Windows contributor cannot currently get
a clean run of the gates. There is no `.gitattributes`, so git's Windows default
(`core.autocrlf=true`) checks the tree out as CRLF, and:

- **`npm run format:check` fails on ~88 files**, including ones nobody has
  touched. Prettier defaults to `endOfLine: "lf"`. Measured: `package.json`
  normalised to LF is **byte-identical** to `prettier package.json` — every
  reported "style issue" is the line ending and nothing else.
- **every multi-line pattern in `tools/guards.mjs` matched zero times**, so
  `npm run verify:guards` reported PATTERN DRIFT rather than proving controls
  load-bearing. The mechanism built to catch a check that silently measures
  nothing was, on Windows, a check that silently measured nothing.

**Fixed in the tool:** matching now adapts the pattern to the file's line
endings, in one place shared with its test (`tools/guard-match.mjs`) rather than
in two copies that disagreed.

**Fixed for the repo, but NOT applied:** a `.gitattributes` with
`* text=auto eol=lf` is added. It governs fresh clones and CI, so the new
`windows-latest` job gets LF. It does **not** rewrite an existing working tree.
Doing that is one command and a tree-wide diff, so it is left as the owner's
own commit rather than buried in this change:

```
git add --renormalize . && git commit -m "Normalise line endings to LF"
```

Until that lands, `npm run format:check` still fails on a pre-existing Windows
clone. It passes on a fresh one.

### 5. Signal semantics differ — UNVERIFIED

`src/acp/transport.ts` sends `SIGTERM`, then escalates to `SIGKILL` after 3s.
`session-manager.ts` sends `SIGTERM` for takeover, and its comment says *"SIGTERM
only — never SIGKILL, which risks an unflushed updates.jsonl"*.

Windows has no signals; Node's `process.kill(pid, 'SIGTERM')` terminates the
process immediately. **The reasoning behind that comment does not hold on
Windows** — the agent gets no chance to flush. Whether this loses a turn's tail
in practice is UNKNOWN. Settled by running `npm run test:real` (needs `grok`) and
`tools/midturn-check.mjs` on Windows.

---

## 4. Start here — in this order

```powershell
git clone https://github.com/sandeep-alluru/grokrc
cd grokrc
npm ci
npm run build
```

> **Steps 1–4 are done.** What they found is in §2 and §3. The instinct behind
> them was right and the prediction was not: the failures were not mostly `bash`
> and `stranger-check.sh` — they were POSIX assumptions in **product** code that
> five CLI smoke steps could never reach. What remains for the next person is
> below, under "still open".

**Step 1 — does the suite even run?** ✅ It does. 149 pass / 169 fail on the
first run; 247 pass / 0 fail / 7 skipped after §3. Run it with `npm run test:mock`
alone if you have no agent — `npm test` also runs the real-stack checks.

**Step 2 — is there an agent at all?** ✅ Native Windows build, `grok 1.0.0`.
The installer is a bash script; run it from Git Bash, or fetch
`https://x.ai/cli/grok-<version>-windows-x86_64.exe` directly. It installs to
`~/.grok/bin/` and does **not** add itself to PATH on Windows — add
`%USERPROFILE%\.grok\bin` yourself.

**Step 3 — does the named pipe bind?** ✅ Yes, including the real CLI reaching a
running daemon through it (`test/doctor-daemon.test.ts`).

**Step 4 — turn on the real gate.** ✅ `windows-latest` is in the `suite` matrix
in `.github/workflows/compat.yml`. Note `npx playwright install --with-deps` is
Ubuntu-only, so `--with-deps` is now applied conditionally.

### Still open, in the order I would take them

1. **Renormalise line endings** (§4b) — one command, its own commit. Until then
   `npm run format:check` fails on a pre-existing Windows clone, for line-ending
   reasons only. A fresh clone and CI are already fine.
2. **`npm run check:stranger` has no Windows form.** `tools/stranger-check.sh`
   is bash, and it installs the package into a sandboxed HOME with a
   system-only PATH to test the first-run experience. That experience is exactly
   where the Windows-specific onboarding lives — no PATH entry from the
   installer, no `grok login` yet — so it is the most valuable remaining gap.
3. **`session/request_permission` is not exercised on Windows.** The conformance
   run reports `the agent did not ask permission on this turn — option shape
   unchecked`, because `isolatedGrokHome({ prompting: false })` writes no
   `config.toml`. Nothing is wrong; it is simply unmeasured here, and
   `tools/e2e-drive.mjs` (which sets `prompting: true`) is the tool that would
   close it.
4. **Push on Windows** is untested. iOS push is verified from Linux; whether a
   Windows-hosted daemon delivers to an iPhone is a different question only in
   that nobody has run it.

---

## 5. How this repo expects work to be done

Not optional here, and the reason the defects above are stated the way they are.

- **Reproduce before claiming.** Found by reading is a hypothesis. Make it fail
  on demand, observe PRE-FIX and POST-FIX, then disable the control and confirm
  the test fails again. Cannot reproduce it? Call it hardening, not a fix.
- **Register a guard.** `tools/guards.mjs` is data; `node tools/verify-guards.mjs
  --only <id>` disables your control and requires the test to fail. A test that
  passes with its control removed measures nothing.
- **Run every gate before pushing:** `npm run format:check`, `npm run lint`,
  `npm run typecheck`, `npm test`, `npm run verify:guards`. Skipping
  `format:check` is how CI went red on 2026-08-10.
- **A skip is not a pass.** Checks needing a real `grok` skip loudly.
  `verify-guards` reports those as `UNPROVABLE HERE`, counted separately from
  proven — do not let a skipped check be read as a green one.
- **`npm test` must leave the tree clean.** `git diff --exit-code` runs in CI.
  Screenshots go to a scratch directory; `npm run shots` regenerates the tracked
  ones deliberately.

---

## 6. Current state, for reference

**VERIFIED at time of writing (on Linux):** 240 tests passing, 27/27 guards
proven load-bearing, format/lint/typecheck clean, CI and Compatibility both
green, `main` at the commit that added this file.

**VERIFIED on Windows 11 / Node 24 / `grok 1.0.0`, with a signed-in agent:**
`npm test` in full — mock suite **256 passing, 0 failing, 7 skipped** (each skip
printing why), then all four real-stack checks **ALL CLEAR**: `live-ui-check`,
`resume-check`, `midturn-check` and `acp-conformance`. `typecheck` and `lint`
clean (two pre-existing `no-explicit-any` warnings, untouched). `format:check`
fails on a pre-existing clone for line-ending reasons only — see §4b.

**§3.5 is settled.** `midturn-check` closes an agent mid-turn and resumes:
*"recovered 2 event(s) the agent never persisted"* and *"the last streamed line
survived the resume"*. Windows has no real `SIGTERM`, and the tail of the turn
survives anyway.

**The protocol surface matches the pin** on Windows — 14 kinds, 14 methods,
`grok 1.0.0` — with `hook_execution` and `last_turn_summary` simply not produced
by that turn, and permission options unexercised because the isolated home runs
with prompting off.

**Verified against a real daemon over a real network**, which the suite cannot
do: `npm run check:live` against a Tailscale-bound daemon paired a browser
through the **named pipe**, loaded the PWA, opened a WebSocket, created a
session and cancelled a turn — 17 checks, ALL CLEAR.

**Guards: 31 of 31 proven load-bearing**, including the five added here
(`path-containment-refuses-escapes`,
`takeover-identity-matches-the-platform-shape`,
`exposure-notice-tells-the-truth`, `config-dir-drops-inherited-access`, and the
repaired `harness-refuses-real-grok-home`).

`stdin-error-handler` deserves a note: it is proven on Linux and is a genuine
platform limit here rather than a weak test. That control is detected by the process
*crashing* on an unhandled stream error, which requires a write to land in the
window between the agent dying and `close` arriving. Measured here: **40 of 40
sends took the `stdin.writable === false` branch in `send()` and
`stdin.write` was never reached** — no EPIPE, no error event, nothing to crash.
`verify:guards` runs on ubuntu-latest in CI, where it proves 29/29, so this
costs no coverage; it is recorded in `tools/guards.mjs` so the next Windows run
does not mistake it for a regression.

While measuring this, both tests in `test/transport-resilience.test.ts` turned
out to be spawning `true` and `sh` in `/tmp` — none of which exist on Windows —
so `spawn` failed on the CWD and the transport under test never ran at all. They
now use `process.execPath`, which exists everywhere.

Backlog: `npm run backlog` — 22 of 25 closed. The three open items need physical
hardware or the owner's decision (a VPS for relay testing, an Android device,
and deleting two backup bundles in `$HOME`).
