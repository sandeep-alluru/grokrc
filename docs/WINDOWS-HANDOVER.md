# Windows compatibility — handover

**Written:** 2026-08-10, from a Linux workstation. Nothing in this document was
run on Windows by its author. Every claim below is labelled **VERIFIED**,
**UNVERIFIED**, or **UNKNOWN**, and the check that settles each open one is
named. Where you find this document wrong, the document is wrong — trust the
machine in front of you.

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

**UNKNOWN — the test suite has never run on Windows.** `.github/workflows/compat.yml`
runs the `suite` job on `[ubuntu-latest, macos-latest]` only. The Windows jobs
run five CLI smoke steps and nothing else. **This is the single biggest gap, and
it is the first thing to close.**

**UNKNOWN — whether `grok` itself exists for Windows.** grokrc drives xAI's Grok
Build over ACP (`grok agent stdio`). Whether xAI ships a Windows build was not
checked from here. If it does not, the daemon runs but can open no session, and
WSL2 becomes the supported path rather than native Windows.

**UNKNOWN — whether the named pipe actually binds.** The code is written; no
Windows process has executed it. Settled by §4 step 3.

---

## 3. Known defects, in priority order

### 1. `looksLikeGrok` cannot read a Windows path containing spaces — OPEN

`src/daemon/session-manager.ts` takes argv0 by splitting the command line on
whitespace. `C:\Program Files\grok\grok.exe agent stdio` yields `C:\Program`, so
a genuine agent is rejected as "not a grok process" — and `Program Files` is the
normal install location.

This is asserted as a known limit in `test/windows-takeover.test.ts` so it stays
visible.

**Do not fix this by pattern-matching the whole string.** `sshd --config
/etc/grok` would then match, and this function exists precisely to stop a phone
tap killing an unrelated process. The fix belongs in the Windows implementation
of `processArgs`, which must return **the executable path alone**:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object -ExpandProperty ExecutablePath
```

With a clean path and no arguments, the existing separator handling already
works — `looksLikeGrok('C:\tools\grok.exe')` passes today.

### 2. `processArgs` has no Windows implementation — OPEN

It shells out to `ps -o args= -p <pid>`, which does not exist on Windows.

It no longer lies about that. `ENOENT` (the `ps` binary is missing) now returns
`ARGS_UNKNOWN`, distinct from `null` (ps ran, the pid is gone). `takeOver`
refuses on `ARGS_UNKNOWN` with a message naming the cause.

**This was a real safety bug, not a cosmetic one.** Previously both cases
returned `null`, and `takeOver` reads `null` as *"died between the registry read
and now — nothing to stop"* and resumes **without killing**. On any machine
without `ps`, every takeover would have skipped the safety check and put two
agents on one conversation — the exact thing `resume()` exists to refuse.

So on Windows today: **takeover fails safely and loudly.** Implementing §3.1
turns it on.

### 3. No service manager off Linux — OPEN

`packaging/` contains only systemd units. There is no Windows equivalent, so
"run it as a service" does not apply. Reasonable options, in rough order of
effort: a Startup-folder shortcut, a Scheduled Task at logon, or NSSM. None has
been tried.

### 4. File permissions are not enforced on Windows — OPEN, security-relevant

`src/daemon/config.ts` writes with `mode: 0o600` and creates `CONFIG_DIR` with
`0o700`. Windows largely ignores POSIX modes. Device tokens are stored hashed
(`test/server.test.ts` asserts the plaintext token never reaches disk), so this
is not a token-disclosure hole, but the config directory is less protected than
on Unix.

Related and already documented in `SECURITY.md`: Windows named pipes are
machine-global and Node exposes no ACL control, so the control pipe's name is
*unguessable* rather than *protected*. On Unix the socket is `chmod 0600` in the
user's own directory.

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

**Step 1 — does the suite even run?** This is the highest-value unknown.

```powershell
npm test
```

Expect failures; they are the work. Capture the whole output before fixing
anything. Likely candidates, all UNVERIFIED: tests that spawn `bash`, tests
asserting POSIX paths, and `tools/stranger-check.sh` (a bash script).

**Step 2 — is there an agent at all?**

```powershell
grok --version
node dist/cli.js doctor
```

If `grok` does not exist for Windows, stop and reconsider scope: WSL2 would then
be the supported path, and everything below applies to the WSL side instead.

**Step 3 — does the named pipe bind?** The one piece of Windows-specific code
written blind.

```powershell
node dist/cli.js up --port 4319
# in a second terminal:
node dist/cli.js pair
```

`pair` reaching the running daemon proves the pipe works end to end. If `up`
prints `⚠ control socket unavailable`, that message contains the error — it is
the whole answer.

**Step 4 — turn on the real gate.** Once the suite passes, add `windows-latest`
to the `suite` job matrix in `.github/workflows/compat.yml` (it currently lists
only ubuntu and macOS). Until that lands, Windows support is a claim rather than
a measurement.

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

**VERIFIED at time of writing:** 240 tests passing, 27/27 guards proven
load-bearing, format/lint/typecheck clean, CI and Compatibility both green,
`main` at the commit that added this file.

Backlog: `npm run backlog` — 22 of 25 closed. The three open items need physical
hardware or the owner's decision (a VPS for relay testing, an Android device,
and deleting two backup bundles in `$HOME`).
